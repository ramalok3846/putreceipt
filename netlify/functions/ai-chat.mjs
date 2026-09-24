// Netlify 스트리밍 함수: AI 요약/채팅(문장 생성)은 메모리를 많이 써서 브라우저에서 직접
// 돌리면 저사양 기기에서 크래시가 났습니다. 그래서 이 서버가 대신 Gemini 무료 API를
// 호출합니다. API 키는 절대 클라이언트 코드에 넣지 않고 이 서버(환경변수)에만 둡니다.
// 답변을 실시간으로 타이핑되듯 보여주기 위해 Gemini의 스트리밍 응답을 그대로 클라이언트로
// 중계합니다. 사용량은 "하루 요청 횟수"가 아니라 "하루 토큰 총량"으로 관리합니다(계정별
// Firebase 기록, 클라이언트가 임의로 우회할 수 없도록 이 서버에서만 확인·증가시킴).
// GitHub Pages(정적 호스팅)는 서버 함수를 실행할 수 없어서, GitHub Pages 페이지도 이 Netlify
// 함수를 원격으로 호출합니다. 그래서 다른 출처(origin)의 요청도 허용하는 CORS 헤더가 필요합니다.
const DAILY_TOKEN_LIMIT = 50000;
const DB_URL = "https://fir-2-f3b80-default-rtdb.asia-southeast1.firebasedatabase.app";
const ALLOWED_ORIGINS = new Set([
  "https://lagem1535-create.github.io",
  "https://melodic-dusk-f654e9.netlify.app",
]);

// 사용자에게는 "가벼움/보통/정밀/최대"만 보여주고, 실제 모델명·사고 토큰량은 서버에만 둡니다.
// 이 계정에서 실제로 쓸 수 있는 모델은 3.5 Flash-Lite / 3.6 Flash / 3.1 Pro로 확인되었습니다
// (버전 번호가 모델별로 다릅니다. gemini-3.6-flash-lite·gemini-3.6-pro는 존재하지 않아 오류가 났었음).
// maxOutputTokens는 사고 토큰까지 합친 전체 한도라서, thinkingBudget보다 넉넉하게 커야
// 합니다(그렇지 않으면 생각만 하다가 정작 답변에 쓸 토큰이 남지 않아 빈 응답이 됩니다).
const TIER_CONFIG = {
  low: { model: "gemini-3.5-flash-lite", maxOutputTokens: 1024 },
  medium: { model: "gemini-3.6-flash", thinkingBudget: 1024, maxOutputTokens: 3072 },
  high: { model: "gemini-3.1-pro", thinkingBudget: 8192, maxOutputTokens: 12288 },
  extreme: { model: "gemini-3.1-pro", thinkingBudget: -1, maxOutputTokens: 16384 },
};

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://melodic-dusk-f654e9.netlify.app";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(status, body, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

export default async (req) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다. Netlify 환경변수를 확인해주세요." }, cors);
  }

  let payload;
  try { payload = await req.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  const { messages, uid, idToken, tier: rawTier } = payload;
  if (!Array.isArray(messages) || !messages.length) {
    return jsonResponse(400, { error: "messages가 필요합니다." }, cors);
  }
  if (!uid || !idToken) {
    return jsonResponse(401, { error: "로그인 정보가 필요합니다." }, cors);
  }
  const tierConfig = TIER_CONFIG[rawTier] || TIER_CONFIG.medium;

  const today = new Date().toISOString().slice(0, 10);
  const usagePath = `users/${uid}/aiUsage/${today}`;

  let currentTokens;
  try {
    // 오늘 사용한 토큰 총량 확인 (Firebase 보안 규칙이 본인 uid 경로만 읽기/쓰기 허용하는지로 인증을 대신함)
    const countRes = await fetch(`${DB_URL}/${usagePath}.json?auth=${idToken}`);
    if (!countRes.ok) {
      return jsonResponse(401, { error: "인증에 실패했습니다. 다시 로그인 후 시도해주세요." }, cors);
    }
    currentTokens = (await countRes.json()) || 0;
  } catch {
    return jsonResponse(502, { error: "AI 서버 호출에 실패했습니다." }, cors);
  }
  if (currentTokens >= DAILY_TOKEN_LIMIT) {
    return jsonResponse(429, { error: `오늘 사용할 수 있는 AI 토큰(${DAILY_TOKEN_LIMIT.toLocaleString("ko-KR")})을 모두 썼습니다. 내일 다시 시도해주세요.` }, cors);
  }

  const systemMsg = messages.find(m => m.role === "system");
  const rawContents = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  // Gemini는 user/model 턴이 엄격히 교대해야 합니다. 응답 생성에 실패한 이전 시도들이
  // 쌓이면 연속된 user 턴이 여러 개 남을 수 있어(답 없이 질문만 저장됨), 같은 역할이
  // 연속되면 하나로 합쳐서 항상 교대 구조가 되도록 방어합니다.
  const contents = [];
  for (const c of rawContents) {
    const last = contents[contents.length - 1];
    if (last && last.role === c.role) last.parts[0].text += "\n" + c.parts[0].text;
    else contents.push(c);
  }

  const generationConfig = { temperature: 0.3, maxOutputTokens: tierConfig.maxOutputTokens || 2000 };
  if (tierConfig.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: tierConfig.thinkingBudget };
  }

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${tierConfig.model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
          generationConfig,
        }),
      }
    );
  } catch {
    return jsonResponse(502, { error: "AI 서버 호출에 실패했습니다." }, cors);
  }

  if (!geminiRes.ok || !geminiRes.body) {
    let msg = "AI 서버 오류가 발생했습니다.";
    try { const errData = await geminiRes.json(); msg = errData?.error?.message || msg; } catch { /* 무시 */ }
    return jsonResponse(502, { error: msg }, cors);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = geminiRes.body.getReader();
      let buffer = "";
      let finalTokenCount = 0;
      let hasText = false;
      let finishReason = null;
      let blockReason = null;
      let chunkCount = 0;
      let streamError = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Google 인프라가 CRLF(\r\n)로 줄바꿈을 보내는 경우가 있어, \n\n 구분자를 찾기 전에
          // \r\n을 \n으로 정규화합니다(안 하면 이벤트를 하나도 못 읽어 "청크 0개"가 됨).
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = rawEvent.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            let chunk;
            try { chunk = JSON.parse(jsonStr); } catch { continue; }
            chunkCount++;
            const text = (chunk?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
            if (text) { hasText = true; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`)); }
            if (chunk?.candidates?.[0]?.finishReason) finishReason = chunk.candidates[0].finishReason;
            if (chunk?.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
            if (chunk?.usageMetadata?.totalTokenCount) finalTokenCount = chunk.usageMetadata.totalTokenCount;
          }
        }
      } catch (e) {
        streamError = `스트리밍 중 오류가 발생했습니다. (${e?.message || e})`;
      }

      // 사고 토큰만 쓰고 실제 답변을 못 만든 경우에도 이미 쓴 토큰은 사용량에 반영합니다.
      const newTotal = currentTokens + (finalTokenCount || 0);
      try {
        await fetch(`${DB_URL}/${usagePath}.json?auth=${idToken}`, { method: "PUT", body: JSON.stringify(newTotal) });
      } catch { /* 사용량 기록 실패는 응답 자체를 막지 않음 */ }

      if (streamError) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: streamError })}\n\n`));
      } else if (!hasText) {
        const detail = blockReason ? `프롬프트 차단: ${blockReason}` : finishReason ? `종료 사유: ${finishReason}` : `수신 청크 ${chunkCount}개`;
        const reasonText = finishReason === "MAX_TOKENS"
          ? `생각하는 데 토큰을 다 써서 답변을 만들지 못했습니다. 등급을 낮추거나 다시 시도해보세요. (${detail})`
          : (blockReason || finishReason === "SAFETY" || finishReason === "RECITATION")
          ? `안전 정책으로 답변이 차단되었습니다. (${detail})`
          : `AI가 응답을 생성하지 못했습니다. 다시 시도해주세요. (${detail})`;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: reasonText })}\n\n`));
      } else {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, totalTokens: finalTokenCount, remaining: Math.max(DAILY_TOKEN_LIMIT - newTotal, 0) })}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
};
