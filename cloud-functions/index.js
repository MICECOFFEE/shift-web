const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

if (!admin.apps.length) admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

exports.aiShiftInstruction = onRequest(
  {
    region: 'asia-northeast1',
    secrets: [ANTHROPIC_API_KEY],
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

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      const systemPrompt = [
        'あなたは100g COFFEEの月次シフトを、ユーザーの自然言語指示に従って部分修正するアシスタントです。',
        '入力として、現状のシフトデータ（staff, locs, schedule, locDates）とユーザー指示が与えられます。',
        '出力は必ず以下のJSONオブジェクトのみを返してください。マークダウンコードフェンスや説明文は一切含めないでください。',
        '',
        '{',
        '  "changes": [',
        '    { "staffId": <number>, "locId": <number>, "day": <1-31 number>, "action": "assign" }',
        '  ],',
        '  "explanation": "変更内容の日本語での短い説明"',
        '}',
        '',
        '規則:',
        '- action は現時点 "assign" のみサポート（指定日・指定場所に指定スタッフを割当。既存割当は上書き）。',
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
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

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
      const filteredChanges = changes.filter(
        (c) =>
          typeof c.staffId === 'number' &&
          typeof c.locId === 'number' &&
          typeof c.day === 'number' &&
          validStaffIds.has(c.staffId) &&
          validLocIds.has(c.locId) &&
          c.day >= 1 &&
          c.day <= 31 &&
          (c.action || 'assign') === 'assign'
      ).map((c) => ({ ...c, action: 'assign' }));

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
