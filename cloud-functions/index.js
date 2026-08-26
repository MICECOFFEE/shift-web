const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '3600',
};

exports.aiShiftProposal = onRequest(
  {
    region: 'asia-northeast1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 120,
    memory: '512MiB',
    cors: true,
  },
  async (req, res) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.set(k, v));

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { staff, locs, wishes, candidates, priorities, monthInfo, extra } = req.body || {};

      if (!Array.isArray(staff) || !Array.isArray(locs)) {
        res.status(400).json({ error: 'staff and locs are required arrays' });
        return;
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      const systemPrompt = [
        'あなたは100g COFFEEの月次シフト作成を支援するアシスタントです。',
        '与えられたスタッフ・出店場所・希望・候補日情報から、当月のシフト割当の提案を日本語で作成してください。',
        '出力は「割当案」「留意点」「代替案」の3つのセクションに分けて、簡潔かつ実行可能な形式で示してください。',
        '各スタッフのrole(mgr=マネージャー, full=フル, part=パート, trainee=研修中), maxDays(月最大出勤日数), maxConsec(最大連勤), prefDows/ngDows(希望/NG曜日), carNo(車番号)を考慮してください。',
        'trainee は単独出勤にせず、mgr/full と組ませてください。',
      ].join('\n');

      const contextJson = JSON.stringify(
        { monthInfo, staff, locs, wishes, candidates, priorities },
        null,
        2
      );

      const userPrompt = [
        '以下が現在のシフト設定データです。',
        '```json',
        contextJson,
        '```',
        '',
        extra ? `追加指示: ${extra}` : '',
        '上記データに基づいてシフト割当案を提案してください。',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      res.status(200).json({
        ok: true,
        text,
        usage: response.usage,
        model: response.model,
      });
    } catch (err) {
      console.error('aiShiftProposal error:', err);
      res.status(500).json({
        ok: false,
        error: err.message || String(err),
      });
    }
  }
);
