const { onRequest } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { oidcFederationProvider } = require('@anthropic-ai/sdk/lib/credentials/oidc-federation');

if (!admin.apps.length) admin.initializeApp();

// --- Anthropic Workload Identity Federation (APIキー不要) ---
// Cloud Functions にアタッチした GCP サービスアカウントの Google 署名 ID トークンを
// メタデータサーバーから取得し、SDK が /v1/oauth/token で短命の Anthropic トークンに交換する。
// 設定値は .env（非シークレット）から読み込む。
const ANTHROPIC_FEDERATION_RULE_ID = defineString('ANTHROPIC_FEDERATION_RULE_ID');
const ANTHROPIC_ORGANIZATION_ID = defineString('ANTHROPIC_ORGANIZATION_ID');
const ANTHROPIC_SERVICE_ACCOUNT_ID = defineString('ANTHROPIC_SERVICE_ACCOUNT_ID');
const ANTHROPIC_WORKSPACE_ID = defineString('ANTHROPIC_WORKSPACE_ID', { default: '' });
// 関数を実行する GCP サービスアカウント（Anthropic 側の連携ルールの sub/email と一致させる）
const GCP_SERVICE_ACCOUNT = 'anthropic-wif@shift-app-920a1.iam.gserviceaccount.com';

const ANTHROPIC_AUDIENCE = 'https://api.anthropic.com';
const GCP_METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' +
  `?audience=${encodeURIComponent(ANTHROPIC_AUDIENCE)}&format=full`;

async function fetchGoogleIdentityToken() {
  const res = await fetch(GCP_METADATA_IDENTITY_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) {
    throw new Error(`GCP metadata server returned ${res.status} while fetching identity token`);
  }
  return res.text();
}

// クライアントはインスタンス単位で再利用し、交換済みトークンのキャッシュ/自動更新を SDK に任せる
let anthropicClient;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      credentials: oidcFederationProvider({
        identityTokenProvider: fetchGoogleIdentityToken,
        federationRuleId: ANTHROPIC_FEDERATION_RULE_ID.value(),
        organizationId: ANTHROPIC_ORGANIZATION_ID.value(),
        serviceAccountId: ANTHROPIC_SERVICE_ACCOUNT_ID.value(),
        workspaceId: ANTHROPIC_WORKSPACE_ID.value() || undefined,
        baseURL: ANTHROPIC_AUDIENCE,
        fetch,
      }),
    });
  }
  return anthropicClient;
}

exports.aiShiftInstruction = onRequest(
  {
    region: 'asia-northeast1',
    serviceAccount: GCP_SERVICE_ACCOUNT,
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    try {
      const { idToken, instruction, shiftData } = req.body || {};

      if (!idToken) {
        res.status(401).json({ ok: false, error: 'idToken is required' });
        return;
      }
      try {
        await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        res.status(401).json({ ok: false, error: 'Invalid idToken: ' + err.message });
        return;
      }

      if (!instruction || typeof instruction !== 'string') {
        res.status(400).json({ ok: false, error: 'instruction (string) is required' });
        return;
      }
      if (!shiftData || !Array.isArray(shiftData.staff) || !Array.isArray(shiftData.locs)) {
        res.status(400).json({ ok: false, error: 'shiftData with staff[] and locs[] is required' });
        return;
      }

      const client = getAnthropicClient();

      const systemPrompt = [
        'あなたは100g COFFEEの月次シフトを、ユーザーの自然言語指示に従って部分修正するアシスタントです。',
        '入力として、現状のシフトデータ（staff, locs, schedule, locDates, wishes）とユーザー指示が与えられます。',
        '',
        '# 入力データの説明',
        '- staff: スタッフ一覧（id, name）',
        '- locs: 場所（出店先）一覧（id, name）',
        '- schedule: 現状の割当',
        '- locDates: 各場所の実際の出店可能日（出店しない日は除外済み）。割当はこの日付の中からのみ行うこと。',
        '- wishes: スタッフごとの希望休(off)・希望出勤(want)の日付リスト。off の日には割り当てず、want の日を優先して割り当てること。',
        '',
        '# 出力形式',
        '出力は必ず以下のJSONオブジェクトのみを返してください。マークダウンコードフェンスや説明文は一切含めないでください。',
        '{',
        '  "changes": [',
        '    {"day": 数値, "staffId": 数値, "locId": 数値, "action": "assign"},',
        '    {"day": 数値, "staffId": 数値, "locId": null, "action": "remove"}',
        '  ],',
        '  "explanation": "変更内容の日本語説明"',
        '}',
        '',
        '# actionの説明',
        '- assign: その日その場所にそのスタッフを割り当てる（既存割当は上書き）',
        '- remove: そのスタッフのその日の割当を削除する（locIdはnullでよい）',
        '',
        '# 優先ルール（必ず守ること）',
        '- wishes.off に含まれる日のスタッフは、明示的に名指しされた場合を除き、候補から除外する',
        '- wishes.want に含まれる日のスタッフを優先的に割り当てる',
        '- locDates に含まれない日には割り当てを行わない',
        '',
        '# 規則',
        '- 該当する変更が無い、または指示が曖昧すぎる場合は changes を空配列にし、explanation で理由を返す。',
        '- staffId と locId は入力に存在するIDのみを使うこと。存在しないIDは絶対に作らない。',
        '- day は 1〜31 の整数。month の日数を超えないこと。',
      ].join('\n');

      const userPrompt = [
        '# 現状のシフトデータ',
        '```json',
        JSON.stringify(shiftData, null, 2),
        '```',
        '',
        '# ユーザー指示',
        instruction,
        '',
        '上記データに対する差分変更をJSONで返してください。',
      ].join('\n');

      const response = await client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      // 出力上限で途中切断された場合は JSON が閉じないため、パース前に明示的なエラーを返す
      if (response.stop_reason === 'max_tokens') {
        res.status(200).json({
          ok: false,
          error: '指示の内容が多すぎます。月全体ではなく「〇〇さんを△△に多め」など、1つの指示に絞って試してください。',
        });
        return;
      }

      const rawText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      let parsed;
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : rawText;
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        console.error('Failed to parse Claude response as JSON:', rawText);
        res.status(200).json({
          ok: false,
          error: 'AIレスポンスをJSONとして解析できませんでした',
          raw: rawText,
        });
        return;
      }

      const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
      const validStaffIds = new Set(shiftData.staff.map((s) => s.id));
      const validLocIds = new Set(shiftData.locs.map((l) => l.id));
      const filteredChanges = changes
        .map((c) => ({ ...c, action: c.action || 'assign' }))
        .filter((c) => {
          if (typeof c.staffId !== 'number' || !validStaffIds.has(c.staffId)) return false;
          if (typeof c.day !== 'number' || c.day < 1 || c.day > 31) return false;
          if (c.action === 'assign') {
            return typeof c.locId === 'number' && validLocIds.has(c.locId);
          }
          if (c.action === 'remove') {
            // remove は locId 不要（null / 省略可）。指定されている場合は存在するIDのみ許可
            return c.locId == null || (typeof c.locId === 'number' && validLocIds.has(c.locId));
          }
          return false;
        })
        .map((c) => ({
          staffId: c.staffId,
          day: c.day,
          locId: c.action === 'remove' ? (c.locId ?? null) : c.locId,
          action: c.action,
        }));

      res.status(200).json({
        ok: true,
        changes: filteredChanges,
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
        usage: response.usage,
      });
    } catch (err) {
      console.error('aiShiftInstruction error:', err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  }
);
