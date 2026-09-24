// Cloudflare Worker: 정적 사이트(ASSETS)와 AI 관련 서버 함수(/api/*)를 함께 서빙합니다.
// 원래 Netlify Functions에 있던 로직입니다 — Netlify 무료 크레딧이 소진되어 이곳으로
// 옮겼습니다(netlify/functions/*.mjs는 참고용으로 남겨두었지만 더 이상 호출되지 않습니다).
// 참고: Cloudflare의 환경변수/시크릿/바인딩은 각 배포(버전)가 만들어질 때의 값이
// 그 배포에 고정됩니다. 이미 배포된 버전이 있는 상태에서 새로 추가/수정하면,
// 그 배포는 옛 값(또는 값 없음)을 계속 씁니다 — 새로 배포(새 커밋 push)해야 반영됩니다.
const DAILY_TOKEN_LIMIT = 50000;
const DB_URL = "https://pal-inte-db-default-rtdb.asia-southeast1.firebasedatabase.app";
const ALLOWED_ORIGINS = new Set([
  "https://lagem1535-create.github.io",
  "https://putreceipt.lagem1535.workers.dev",
]);
const OWNER = "lagem1535-create";
const REPO = "putreceipt";
// firebase-config.js에도 이미 있는 공개 웹 API 키입니다(비밀 값이 아님).
const FIREBASE_WEB_API_KEY = "AIzaSyCEmf0KIiaF11nmS2CfBNA5yxZA9nrtmUU";

// 사용자에게는 "가벼움/보통/정밀/최대"만 보여주고, 실제 모델명·사고 토큰량은 서버에만 둡니다.
const TIER_CONFIG = {
  low: { model: "gemini-3.5-flash-lite", maxOutputTokens: 1024 },
  medium: { model: "gemini-3.6-flash", thinkingBudget: 1024, maxOutputTokens: 3072 },
  high: { model: "gemini-3.1-pro", thinkingBudget: 8192, maxOutputTokens: 12288 },
  extreme: { model: "gemini-3.1-pro", thinkingBudget: -1, maxOutputTokens: 16384 },
};

const RECEIPT_CATEGORIES = ["식비", "카페", "교통", "생필품", "쇼핑", "의료", "기타"];

// AI 채팅이 사용자 대신 실행할 수 있는 함수(도구) 정의. 실제 데이터를 바꾸는
// 동작이라 MUTATING_ACTIONS에 있으면 사용자 본인의 설정(aiConfirmActions)에
// 따라 실행 전에 먼저 확인을 받을 수 있습니다.
const RECEIPT_TOOLS = [{
  functionDeclarations: [
    {
      name: "add_receipt",
      description: "사용자의 요청에 따라 새 영수증을 등록합니다. 사용자가 지출 내역을 저장해달라고 명확히 요청했을 때만 호출하세요.",
      parameters: {
        type: "OBJECT",
        properties: {
          store: { type: "STRING", description: "가게/상호명" },
          amount: { type: "NUMBER", description: "결제 금액(원 단위 숫자)" },
          category: { type: "STRING", description: "식비, 카페, 교통, 생필품, 쇼핑, 의료, 기타 중 하나" },
          date: { type: "STRING", description: "YYYY-MM-DD 형식 날짜. 사용자가 말하지 않았으면 오늘 날짜를 씁니다." },
          time: { type: "STRING", description: "HH:MM 형식 시간(선택)" },
          item: { type: "STRING", description: "상품명(선택)" },
          paymentMethod: { type: "STRING", description: "결제수단(선택, 예: 신한카드, 현금)" },
        },
        required: ["store", "amount", "category", "date"],
      },
    },
    {
      name: "delete_receipt",
      description: "가게명(과 선택적으로 금액·날짜)으로 사용자의 기존 영수증을 찾아 삭제합니다. 여러 개가 일치하면 삭제하지 않고 후보를 알려주니, 그 정보로 사용자에게 다시 물어보세요.",
      parameters: {
        type: "OBJECT",
        properties: {
          store: { type: "STRING", description: "가게/상호명(일부만 일치해도 됨)" },
          amount: { type: "NUMBER", description: "결제 금액(원), 알고 있으면" },
          date: { type: "STRING", description: "YYYY-MM-DD, 알고 있으면" },
        },
        required: ["store"],
      },
    },
    {
      name: "edit_receipt",
      description: "가게명(과 선택적으로 금액·날짜)으로 사용자의 기존 영수증을 찾아 내용을 수정합니다. newStore/newAmount/newCategory/newDate/newItem/newPaymentMethod 중 바꿀 항목만 넣으세요. 여러 개가 일치하면 수정하지 않고 후보를 알려주니, 그 정보로 사용자에게 다시 물어보세요.",
      parameters: {
        type: "OBJECT",
        properties: {
          store: { type: "STRING", description: "수정할 영수증을 찾기 위한 가게/상호명(일부만 일치해도 됨)" },
          amount: { type: "NUMBER", description: "찾기 조건: 결제 금액(원), 알고 있으면" },
          date: { type: "STRING", description: "찾기 조건: YYYY-MM-DD, 알고 있으면" },
          newStore: { type: "STRING", description: "새 가게/상호명(바꿀 경우만)" },
          newAmount: { type: "NUMBER", description: "새 결제 금액(원, 바꿀 경우만)" },
          newCategory: { type: "STRING", description: "새 카테고리: 식비, 카페, 교통, 생필품, 쇼핑, 의료, 기타 중 하나(바꿀 경우만)" },
          newDate: { type: "STRING", description: "새 날짜 YYYY-MM-DD(바꿀 경우만)" },
          newItem: { type: "STRING", description: "새 상품명(바꿀 경우만)" },
          newPaymentMethod: { type: "STRING", description: "새 결제수단(바꿀 경우만)" },
        },
        required: ["store"],
      },
    },
  ],
}];
const MUTATING_ACTIONS = new Set(["add_receipt", "delete_receipt", "edit_receipt"]);

// delete_receipt/edit_receipt가 공통으로 쓰는, 가게명(+선택적 금액/날짜)으로
// 사용자 본인의 영수증 중 일치하는 것을 찾는 로직.
async function findMatchingReceipts(args, uid, idToken) {
  const storeQuery = String(args?.store || "").trim().toLowerCase();
  if (!storeQuery) return { error: { ok: false, error: "가게명이 필요합니다." } };

  let all;
  try {
    const res = await fetch(`${DB_URL}/users/${uid}/receipts.json?auth=${idToken}`);
    if (!res.ok) return { error: { ok: false, error: "영수증 목록을 불러오지 못했습니다." } };
    all = (await res.json()) || {};
  } catch {
    return { error: { ok: false, error: "영수증 목록을 불러오지 못했습니다." } };
  }

  const matches = Object.entries(all).filter(([, r]) => {
    if (!r?.store || !String(r.store).toLowerCase().includes(storeQuery)) return false;
    if (args?.amount != null && Number(r.amount) !== Number(args.amount)) return false;
    if (args?.date && r.date !== args.date) return false;
    return true;
  });
  return { matches };
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://putreceipt.lagem1535.workers.dev";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(status, body, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

// 로그인한 사용자 본인의 "AI 실행 전 확인받기" 설정. 명시적으로 꺼두지
// (false) 않은 이상 기본은 확인받기입니다.
async function getUserConfirmSetting(uid, idToken) {
  try {
    const res = await fetch(`${DB_URL}/users/${uid}/settings/aiConfirmActions.json?auth=${idToken}`);
    if (!res.ok) return true;
    const value = await res.json();
    return value !== false;
  } catch {
    return true;
  }
}

async function executeAddReceipt(args, uid, idToken) {
  const store = String(args?.store || "").trim().slice(0, 60);
  const amount = Number(args?.amount);
  if (!store || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "가게명과 올바른 금액이 필요합니다." };
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(args?.date || "") ? args.date : new Date().toISOString().slice(0, 10);
  const payload = {
    store,
    amount,
    category: RECEIPT_CATEGORIES.includes(args?.category) ? args.category : "기타",
    date,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(args?.time || "") ? args.time : "",
    item: String(args?.item || "").slice(0, 60),
    paymentMethod: String(args?.paymentMethod || "").slice(0, 40),
    docType: "receipt",
    addedByAi: true,
  };
  try {
    const res = await fetch(`${DB_URL}/users/${uid}/receipts.json?auth=${idToken}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: "저장에 실패했습니다." };
    const data = await res.json();
    return { ok: true, receipt: { id: data?.name, ...payload } };
  } catch {
    return { ok: false, error: "저장 중 오류가 발생했습니다." };
  }
}

async function executeDeleteReceipt(args, uid, idToken) {
  const { error, matches } = await findMatchingReceipts(args, uid, idToken);
  if (error) return error;
  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "multiple_matches",
      candidates: matches.slice(0, 5).map(([id, r]) => ({ id, store: r.store, amount: r.amount, date: r.date })),
    };
  }

  const [id, receipt] = matches[0];
  try {
    const delRes = await fetch(`${DB_URL}/users/${uid}/receipts/${id}.json?auth=${idToken}`, { method: "DELETE" });
    if (!delRes.ok) return { ok: false, error: "삭제에 실패했습니다." };
  } catch {
    return { ok: false, error: "삭제 중 오류가 발생했습니다." };
  }
  return { ok: true, deleted: { id, store: receipt.store, amount: receipt.amount, date: receipt.date } };
}

async function executeEditReceipt(args, uid, idToken) {
  const { error, matches } = await findMatchingReceipts(args, uid, idToken);
  if (error) return error;
  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "multiple_matches",
      candidates: matches.slice(0, 5).map(([id, r]) => ({ id, store: r.store, amount: r.amount, date: r.date })),
    };
  }

  const [id, receipt] = matches[0];
  const patch = {};
  if (args?.newStore != null) patch.store = String(args.newStore).trim().slice(0, 60);
  if (args?.newAmount != null) {
    const amount = Number(args.newAmount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "올바른 금액이 아닙니다." };
    patch.amount = amount;
  }
  if (args?.newCategory != null) {
    if (!RECEIPT_CATEGORIES.includes(args.newCategory)) return { ok: false, error: "올바른 카테고리가 아닙니다." };
    patch.category = args.newCategory;
  }
  if (args?.newDate != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.newDate)) return { ok: false, error: "날짜 형식이 올바르지 않습니다." };
    patch.date = args.newDate;
  }
  if (args?.newItem != null) patch.item = String(args.newItem).slice(0, 60);
  if (args?.newPaymentMethod != null) patch.paymentMethod = String(args.newPaymentMethod).slice(0, 40);

  if (Object.keys(patch).length === 0) return { ok: false, error: "바꿀 내용이 없습니다." };

  try {
    const patchRes = await fetch(`${DB_URL}/users/${uid}/receipts/${id}.json?auth=${idToken}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!patchRes.ok) return { ok: false, error: "수정에 실패했습니다." };
  } catch {
    return { ok: false, error: "수정 중 오류가 발생했습니다." };
  }
  return { ok: true, edited: { id, store: receipt.store, amount: receipt.amount, date: receipt.date, ...patch } };
}

async function executeReceiptAction(name, args, uid, idToken) {
  if (name === "add_receipt") return executeAddReceipt(args, uid, idToken);
  if (name === "delete_receipt") return executeDeleteReceipt(args, uid, idToken);
  if (name === "edit_receipt") return executeEditReceipt(args, uid, idToken);
  return { ok: false, error: "알 수 없는 동작입니다." };
}

// Gemini에 한 번 스트리밍 요청을 보내고, 텍스트는 그때그때 controller로 흘려
// 보내면서 functionCall/토큰 수 등 요약 정보를 모아 반환합니다. add_receipt/
// delete_receipt처럼 함수 호출로 이어지는 대화는 이 함수를 여러 번 호출해서
// (함수 실행 결과를 다음 턴에 넣어) 이어갑니다.
async function streamGeminiTurn({ apiKey, model, contents, systemMsg, generationConfig, controller, encoder, decoder }) {
  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg }] } } : {}),
          tools: RECEIPT_TOOLS,
          generationConfig,
        }),
      }
    );
  } catch {
    return { requestError: "AI 서버 호출에 실패했습니다." };
  }

  if (!geminiRes.ok || !geminiRes.body) {
    let msg = "AI 서버 오류가 발생했습니다.";
    try { const errData = await geminiRes.json(); msg = errData?.error?.message || msg; } catch { /* 무시 */ }
    return { requestError: msg };
  }

  const reader = geminiRes.body.getReader();
  let buffer = "";
  let finalTokenCount = 0;
  let hasText = false;
  let functionCall = null;
  let finishReason = null;
  let blockReason = null;
  let chunkCount = 0;
  let streamError = null;
  // Gemini가 "생각(thinking)"을 켠 채로 함수를 호출하면 thoughtSignature가 함께 오는데,
  // 스트리밍에서는 이 값이 functionCall과 같은 Part가 아니라 텍스트 없는 별도 Part로,
  // 심지어 다른 청크로 나뉘어 올 수도 있습니다. 그래서 functionCall이 있는 Part만 보지
  // 않고 매 청크의 모든 Part를 훑어서 이 값을 놓치지 않게 모아둡니다.
  let latestThoughtSignature = null;
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
        const parts = chunk?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || "").join("");
        if (text) { hasText = true; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`)); }
        for (const p of parts) { if (p.thoughtSignature) latestThoughtSignature = p.thoughtSignature; }
        const fcPart = parts.find(p => p.functionCall);
        if (fcPart) functionCall = { name: fcPart.functionCall.name, args: fcPart.functionCall.args || {} };
        if (chunk?.candidates?.[0]?.finishReason) finishReason = chunk.candidates[0].finishReason;
        if (chunk?.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
        if (chunk?.usageMetadata?.totalTokenCount) finalTokenCount = chunk.usageMetadata.totalTokenCount;
      }
    }
    if (functionCall && latestThoughtSignature) functionCall.thoughtSignature = latestThoughtSignature;
  } catch (e) {
    streamError = `스트리밍 중 오류가 발생했습니다. (${e?.message || e})`;
  }

  return { hasText, functionCall, finalTokenCount, finishReason, blockReason, chunkCount, streamError };
}

function geminiErrorText({ blockReason, finishReason, chunkCount }) {
  const detail = blockReason ? `프롬프트 차단: ${blockReason}` : finishReason ? `종료 사유: ${finishReason}` : `수신 청크 ${chunkCount}개`;
  if (finishReason === "MAX_TOKENS") return `생각하는 데 토큰을 다 써서 답변을 만들지 못했습니다. 등급을 낮추거나 다시 시도해보세요. (${detail})`;
  if (blockReason || finishReason === "SAFETY" || finishReason === "RECITATION") return `안전 정책으로 답변이 차단되었습니다. (${detail})`;
  return `AI가 응답을 생성하지 못했습니다. 다시 시도해주세요. (${detail})`;
}

async function handleAiChat(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다. Cloudflare 환경변수를 확인해주세요." }, cors);
  }

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  const { messages, uid, idToken, tier: rawTier, confirmedAction } = payload;
  if (!Array.isArray(messages) || !messages.length) {
    return jsonResponse(400, { error: "messages가 필요합니다." }, cors);
  }
  if (!uid || !idToken) {
    return jsonResponse(401, { error: "로그인 정보가 필요합니다." }, cors);
  }

  const callerEmail = await verifyIdTokenEmail(idToken);
  if (await isBanned(callerEmail, env)) {
    return jsonResponse(403, { error: "이용이 제한된 계정입니다." }, cors);
  }

  const tierConfig = TIER_CONFIG[rawTier] || TIER_CONFIG.medium;
  const dailyLimit = await getDailyTokenLimit(env, callerEmail);

  const today = new Date().toISOString().slice(0, 10);
  const usagePath = `users/${uid}/aiUsage/${today}`;

  let currentTokens;
  try {
    const countRes = await fetch(`${DB_URL}/${usagePath}.json?auth=${idToken}`);
    if (!countRes.ok) {
      return jsonResponse(401, { error: "인증에 실패했습니다. 다시 로그인 후 시도해주세요." }, cors);
    }
    currentTokens = (await countRes.json()) || 0;
  } catch {
    return jsonResponse(502, { error: "AI 서버 호출에 실패했습니다." }, cors);
  }
  if (currentTokens >= dailyLimit) {
    return jsonResponse(429, { error: `오늘 사용할 수 있는 AI 토큰(${dailyLimit.toLocaleString("ko-KR")})을 모두 썼습니다. 내일 다시 시도해주세요.` }, cors);
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

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      let workingContents = contents;
      let sumTokens = 0;
      let pendingAction = confirmedAction && MUTATING_ACTIONS.has(confirmedAction.name)
        ? { name: confirmedAction.name, args: confirmedAction.args || {}, thoughtSignature: confirmedAction.thoughtSignature }
        : null;
      let finished = false;

      // 최대 4회: 함수 호출 하나당 한 턴씩 쓰고, 마지막에는 자연어 답변으로 마무리.
      for (let iteration = 0; iteration < 4 && !finished; iteration++) {
        let functionCallToRun = pendingAction;
        pendingAction = null;

        if (!functionCallToRun) {
          const turn = await streamGeminiTurn({
            apiKey, model: tierConfig.model, contents: workingContents,
            systemMsg: systemMsg?.content, generationConfig, controller, encoder, decoder,
          });

          if (turn.requestError) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: turn.requestError })}\n\n`));
            finished = true;
            break;
          }
          sumTokens += turn.finalTokenCount || 0;

          if (turn.streamError) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: turn.streamError })}\n\n`));
            finished = true;
            break;
          }
          if (!turn.hasText && !turn.functionCall) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: geminiErrorText(turn) })}\n\n`));
            finished = true;
            break;
          }
          if (!turn.functionCall) {
            const remaining = Math.max(dailyLimit - (currentTokens + sumTokens), 0);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, totalTokens: sumTokens, remaining })}\n\n`));
            finished = true;
            break;
          }

          functionCallToRun = turn.functionCall;
          if (MUTATING_ACTIONS.has(functionCallToRun.name) && await getUserConfirmSetting(uid, idToken)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ confirmRequired: functionCallToRun })}\n\n`));
            finished = true;
            break;
          }
        }

        const result = await executeReceiptAction(functionCallToRun.name, functionCallToRun.args, uid, idToken);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ actionResult: { name: functionCallToRun.name, args: functionCallToRun.args, result } })}\n\n`));
        const functionCallPart = { functionCall: { name: functionCallToRun.name, args: functionCallToRun.args } };
        if (functionCallToRun.thoughtSignature) functionCallPart.thoughtSignature = functionCallToRun.thoughtSignature;
        workingContents = [
          ...workingContents,
          { role: "model", parts: [functionCallPart] },
          { role: "user", parts: [{ functionResponse: { name: functionCallToRun.name, response: result } }] },
        ];
      }

      // 사고 토큰만 쓰고 실제 답변을 못 만든 경우에도 이미 쓴 토큰은 사용량에 반영합니다.
      const newTotal = currentTokens + sumTokens;
      try {
        await fetch(`${DB_URL}/${usagePath}.json?auth=${idToken}`, { method: "PUT", body: JSON.stringify(newTotal) });
      } catch { /* 사용량 기록 실패는 응답 자체를 막지 않음 */ }

      if (!finished) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "요청을 처리하는 데 시도 횟수를 다 썼습니다. 다시 시도해주세요." })}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

async function verifyIdTokenEmail(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.users?.[0]?.email || null;
}

// 관리(어드민) 페이지가 다루는 여러 목록/설정을 하나의 KV(MANAGERS_KV)에
// 서로 다른 키로 저장합니다. KV가 설정되지 않았거나 한 번도 저장된 적이
// 없으면 각 항목의 기본값(또는 환경변수)을 사용합니다.
const MANAGERS_KV_KEY = "managers";
const BANNED_KV_KEY = "bannedEmails";
const DAILY_LIMIT_KV_KEY = "dailyTokenLimit";
const BANNER_KV_KEY = "banner";
const ANNOUNCEMENT_KV_KEY = "announcement";
const USER_LIMITS_KV_KEY = "userLimits";
const ADMIN_LOG_KV_KEY = "adminLog";
const ADMIN_LOG_MAX_ENTRIES = 200;

async function getKvValue(env, key) {
  if (!env.MANAGERS_KV) return null;
  const raw = await env.MANAGERS_KV.get(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setKvValue(env, key, value) {
  await env.MANAGERS_KV.put(key, JSON.stringify(value));
}

// 매니저: 오너와 동일한 권한을 갖는 추가 계정들. 관리 페이지에서 한 번이라도
// 추가/삭제하면 KV가 기준이 되고, 그 전까지는 환경변수 MANAGER_EMAILS
// (쉼표로 구분, 예: "a@x.com, b@x.com")를 초기 목록으로 사용합니다.
async function getManagerEmails(env) {
  const kvList = await getKvValue(env, MANAGERS_KV_KEY);
  if (kvList !== null) return kvList;
  return (env.MANAGER_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}
async function setManagerEmails(env, list) { await setKvValue(env, MANAGERS_KV_KEY, list); }

// 차단된 이메일: 로그인과 AI 기능 사용이 막힙니다.
async function getBannedEmails(env) { return (await getKvValue(env, BANNED_KV_KEY)) || []; }
async function setBannedEmails(env, list) { await setKvValue(env, BANNED_KV_KEY, list); }
async function isBanned(email, env) {
  if (!email) return false;
  return (await getBannedEmails(env)).includes(email.toLowerCase());
}

// AI 하루 토큰 한도: 관리 페이지에서 조정 가능. email이 있고 그 사람만의 한도가
// 설정돼 있으면 그 값을 우선 쓰고, 아니면 전체 기본값(설정 없으면 DAILY_TOKEN_LIMIT).
async function getDailyTokenLimit(env, email) {
  if (!env.MANAGERS_KV) return DAILY_TOKEN_LIMIT;
  if (email) {
    const limits = await getUserLimits(env);
    const own = limits[email.toLowerCase()];
    if (Number.isFinite(own) && own > 0) return own;
  }
  const raw = await env.MANAGERS_KV.get(DAILY_LIMIT_KV_KEY);
  const num = Number(raw);
  return raw !== null && Number.isFinite(num) && num > 0 ? num : DAILY_TOKEN_LIMIT;
}
async function setDailyTokenLimit(env, value) { await env.MANAGERS_KV.put(DAILY_LIMIT_KV_KEY, String(value)); }

// 개인별 AI 하루 토큰 한도 재정의: { 이메일: 한도 } 형태로 저장.
async function getUserLimits(env) { return (await getKvValue(env, USER_LIMITS_KV_KEY)) || {}; }
async function setUserLimits(env, limits) { await setKvValue(env, USER_LIMITS_KV_KEY, limits); }

// 오너/매니저가 관리 페이지에서 한 행동(매니저·차단 추가/삭제, 한도 변경,
// 배너/공지 변경, PR 승인/거부 등)을 최근 것부터 최대 ADMIN_LOG_MAX_ENTRIES개
// 남겨둡니다. 관리 페이지에서 "누가 언제 뭘 바꿨는지" 확인하는 용도입니다.
async function getAdminLog(env) { return (await getKvValue(env, ADMIN_LOG_KV_KEY)) || []; }
async function logAdminAction(env, email, action, detail) {
  if (!env.MANAGERS_KV) return;
  const current = await getAdminLog(env);
  const updated = [{ ts: Date.now(), email: email || "알 수 없음", action, detail: detail || "" }, ...current].slice(0, ADMIN_LOG_MAX_ENTRIES);
  await setKvValue(env, ADMIN_LOG_KV_KEY, updated);
}

// 로그인한 모든 페이지 상단에 뜨는 배너.
const BANNER_SIZES = ["small", "medium", "large"];

// 예전엔 배너가 문구 하나짜리 { enabled, text, id }였습니다. 지금은 여러 개를
// 돌아가며 보여줄 수 있어서 items 배열로 바뀌었는데, 예전 형태로 저장된
// 값도 items: [text] 하나짜리 배열로 자동 변환해서 그대로 보여줍니다.
async function getBanner(env) {
  const raw = await getKvValue(env, BANNER_KV_KEY);
  if (!raw) return { enabled: false, size: "medium", items: [], id: null };
  const items = Array.isArray(raw.items) ? raw.items : (raw.text ? [raw.text] : []);
  return {
    enabled: !!raw.enabled,
    size: BANNER_SIZES.includes(raw.size) ? raw.size : "medium",
    items,
    id: raw.id || null,
  };
}
async function setBanner(env, banner) { await setKvValue(env, BANNER_KV_KEY, banner); }

// 앱에 들어올 때 한 번 뜨는 공지 모달. id가 바뀔 때마다 다시 보여줍니다.
async function getAnnouncement(env) {
  return (await getKvValue(env, ANNOUNCEMENT_KV_KEY)) || { enabled: false, title: "", body: "", imageUrl: "", accentColor: "#6d3df2", linkUrl: "", linkText: "", id: null };
}
async function setAnnouncement(env, announcement) { await setKvValue(env, ANNOUNCEMENT_KV_KEY, announcement); }

// idToken의 로그인 이메일이 오너/매니저인지 확인합니다. role은 "owner" | "manager" | null.
async function roleForEmail(email, env) {
  const ownerEmail = (env.OWNER_EMAIL || "").toLowerCase();
  const managerEmails = await getManagerEmails(env);
  const normalizedEmail = email ? email.toLowerCase() : null;
  if (!normalizedEmail) return null;
  if (ownerEmail && normalizedEmail === ownerEmail) return "owner";
  if (managerEmails.includes(normalizedEmail)) return "manager";
  return null;
}

async function checkRole(idToken, env) {
  const email = await verifyIdTokenEmail(idToken);
  if (!email) return { email: null, role: null };
  return { email: email.toLowerCase(), role: await roleForEmail(email, env) };
}

// /preview 페이지가 내용을 보여주기 전에, 로그인한 사람이 오너/매니저인지 확인하는 용도입니다.
async function handlePreviewStatus(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { role } = await checkRole(payload.idToken, env);
  return jsonResponse(200, { authorized: !!role, role }, cors);
}

// 누구나(로그인만 하면) 호출: 로그인/AI 사용 전에 차단된 계정인지 확인하는 용도입니다.
async function handleAccessStatus(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const email = await verifyIdTokenEmail(payload.idToken);
  return jsonResponse(200, { banned: await isBanned(email, env), dailyTokenLimit: await getDailyTokenLimit(env, email) }, cors);
}

// 관리(어드민) 페이지의 이메일 목록형 리소스(매니저/차단 목록) 공용 처리기 —
// 오너만 조회/추가/삭제할 수 있습니다.
async function handleEmailListEndpoint(request, env, { getList, setList, forbidOwnerEmail, logLabel }) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { email: actorEmail, role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  const ownerEmail = (env.OWNER_EMAIL || "").toLowerCase();
  const action = payload.action || "list";

  if (action === "list") {
    return jsonResponse(200, { owner: ownerEmail, list: await getList(env) }, cors);
  }

  if (action === "add" || action === "remove") {
    if (!env.MANAGERS_KV) {
      return jsonResponse(500, { error: "저장소(MANAGERS_KV)가 설정되지 않았습니다." }, cors);
    }
    const email = String(payload.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return jsonResponse(400, { error: "올바른 이메일을 입력해주세요." }, cors);
    }
    const current = await getList(env);
    let updated;
    if (action === "add") {
      if (forbidOwnerEmail && email === ownerEmail) return jsonResponse(400, { error: "오너 이메일은 추가할 수 없습니다." }, cors);
      updated = current.includes(email) ? current : [...current, email];
    } else {
      updated = current.filter(e => e !== email);
    }
    await setList(env, updated);
    await logAdminAction(env, actorEmail, `${logLabel} ${action === "add" ? "추가" : "삭제"}`, email);
    return jsonResponse(200, { owner: ownerEmail, list: updated }, cors);
  }

  return jsonResponse(400, { error: "알 수 없는 action입니다." }, cors);
}

async function handleManagementManagers(request, env) {
  return handleEmailListEndpoint(request, env, { getList: getManagerEmails, setList: setManagerEmails, forbidOwnerEmail: true, logLabel: "매니저" });
}

async function handleManagementBanned(request, env) {
  return handleEmailListEndpoint(request, env, { getList: getBannedEmails, setList: setBannedEmails, forbidOwnerEmail: true, logLabel: "차단" });
}

// AI 하루 토큰 한도 조회/조정 — 오너 전용.
async function handleManagementSettings(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { email: actorEmail, role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  const action = payload.action || "get";
  if (action === "get") {
    return jsonResponse(200, { dailyTokenLimit: await getDailyTokenLimit(env) }, cors);
  }
  if (action === "set") {
    if (!env.MANAGERS_KV) return jsonResponse(500, { error: "저장소(MANAGERS_KV)가 설정되지 않았습니다." }, cors);
    const value = Math.floor(Number(payload.dailyTokenLimit));
    if (!Number.isFinite(value) || value <= 0) return jsonResponse(400, { error: "1 이상의 숫자를 입력해주세요." }, cors);
    await setDailyTokenLimit(env, value);
    await logAdminAction(env, actorEmail, "기본 AI 한도 변경", `${value.toLocaleString("ko-KR")} 토큰`);
    return jsonResponse(200, { dailyTokenLimit: value }, cors);
  }
  return jsonResponse(400, { error: "알 수 없는 action입니다." }, cors);
}

// 로그인한 전체 사용자 목록(이메일/로그인 시각·횟수/영수증 수) 조회 — 오너 전용.
// Firebase RTDB 레거시 데이터베이스 시크릿(FIREBASE_DB_SECRET)으로 전체 트리를 읽되,
// 응답에는 요약 정보만 담아 실제 영수증 내용은 절대 클라이언트로 내보내지 않습니다.
async function handleManagementUsers(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  if (!env.FIREBASE_DB_SECRET) {
    return jsonResponse(500, { error: "사용자 목록 기능을 쓰려면 서버에 FIREBASE_DB_SECRET을 설정해야 합니다." }, cors);
  }

  let data;
  try {
    const res = await fetch(`${DB_URL}/users.json?auth=${env.FIREBASE_DB_SECRET}`);
    if (!res.ok) return jsonResponse(502, { error: "사용자 정보를 불러오지 못했습니다." }, cors);
    data = await res.json();
  } catch {
    return jsonResponse(502, { error: "사용자 정보를 불러오지 못했습니다." }, cors);
  }

  const userLimits = await getUserLimits(env);
  const users = Object.entries(data || {}).map(([uid, u]) => ({
    uid,
    email: u?.profile?.email || null,
    createdAt: u?.profile?.createdAt || null,
    lastLoginAt: u?.profile?.lastLoginAt || null,
    loginCount: u?.profile?.loginCount || 0,
    receiptCount: u?.receipts ? Object.keys(u.receipts).length : 0,
    dailyTokenLimit: (u?.profile?.email && userLimits[u.profile.email.toLowerCase()]) || null,
  }));
  users.sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));

  return jsonResponse(200, { users }, cors);
}

// 로그인한 모든 사용자가 호출: 배너/공지 내용을 조회합니다. 오너/매니저 여부와 무관.
async function handleNotices(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const email = await verifyIdTokenEmail(payload.idToken);
  if (!email) return jsonResponse(401, { error: "로그인 정보가 올바르지 않습니다." }, cors);

  const [banner, announcement, banned, role] = await Promise.all([
    getBanner(env), getAnnouncement(env), isBanned(email, env), roleForEmail(email, env),
  ]);

  // 어드민/매니저 전용 화면 효과(화면 테두리 그라데이션) 표시 여부. 본인 설정
  // (adminBackground)까지 같이 켜져 있어야 하므로, 권한이 있을 때만 조회합니다.
  let adminBackground = false;
  if (role && payload.uid) {
    try {
      const res = await fetch(`${DB_URL}/users/${payload.uid}/settings/adminBackground.json?auth=${payload.idToken}`);
      if (res.ok) adminBackground = (await res.json()) === true;
    } catch { /* 무시 */ }
  }

  return jsonResponse(200, { banner, announcement, banned, role, adminBackground }, cors);
}

// 관리 페이지 전용: 배너/공지 조회 및 수정 — 오너만 가능.
async function handleManagementNotices(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { email: actorEmail, role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  const action = payload.action || "get";

  if (action === "get") {
    const [banner, announcement] = await Promise.all([getBanner(env), getAnnouncement(env)]);
    return jsonResponse(200, { banner, announcement }, cors);
  }

  if (!env.MANAGERS_KV) {
    return jsonResponse(500, { error: "저장소(MANAGERS_KV)가 설정되지 않았습니다." }, cors);
  }

  if (action === "setBanner") {
    const items = Array.isArray(payload.items)
      ? payload.items.map(t => String(t || "").trim().slice(0, 300)).filter(Boolean).slice(0, 5)
      : [];
    const size = BANNER_SIZES.includes(payload.size) ? payload.size : "medium";
    const banner = { enabled: !!payload.enabled, size, items, id: `${Date.now()}` };
    await setBanner(env, banner);
    await logAdminAction(env, actorEmail, "배너 설정 변경", banner.enabled ? `켜짐 · 문구 ${items.length}개` : "꺼짐");
    return jsonResponse(200, { banner }, cors);
  }

  if (action === "setAnnouncement") {
    const accentColor = /^#[0-9a-fA-F]{3,8}$/.test(payload.accentColor || "") ? payload.accentColor : "#6d3df2";
    const imageUrl = /^https:\/\//.test(payload.imageUrl || "") ? String(payload.imageUrl).slice(0, 500) : "";
    const linkUrl = /^https:\/\//.test(payload.linkUrl || "") ? String(payload.linkUrl).slice(0, 500) : "";
    const announcement = {
      enabled: !!payload.enabled,
      title: String(payload.title || "").slice(0, 100),
      body: String(payload.body || "").slice(0, 2000),
      imageUrl,
      accentColor,
      linkUrl,
      linkText: linkUrl ? String(payload.linkText || "").slice(0, 40) : "",
      id: `${Date.now()}`,
    };
    await setAnnouncement(env, announcement);
    await logAdminAction(env, actorEmail, "공지 게시", announcement.enabled ? (announcement.title || "(제목 없음)") : "꺼짐");
    return jsonResponse(200, { announcement }, cors);
  }

  return jsonResponse(400, { error: "알 수 없는 action입니다." }, cors);
}

// 관리 페이지 전용: 개인별 AI 하루 토큰 한도 조회/설정/해제 — 오너만 가능.
async function handleManagementUserLimits(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { email: actorEmail, role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  const action = payload.action || "list";
  if (action === "list") {
    return jsonResponse(200, { limits: await getUserLimits(env) }, cors);
  }

  if (action === "set" || action === "remove") {
    if (!env.MANAGERS_KV) return jsonResponse(500, { error: "저장소(MANAGERS_KV)가 설정되지 않았습니다." }, cors);
    const email = String(payload.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return jsonResponse(400, { error: "올바른 이메일을 입력해주세요." }, cors);

    const limits = await getUserLimits(env);
    if (action === "set") {
      const value = Math.floor(Number(payload.dailyTokenLimit));
      if (!Number.isFinite(value) || value <= 0) return jsonResponse(400, { error: "1 이상의 숫자를 입력해주세요." }, cors);
      limits[email] = value;
      await logAdminAction(env, actorEmail, "개인 AI 한도 설정", `${email} → ${value.toLocaleString("ko-KR")} 토큰`);
    } else {
      delete limits[email];
      await logAdminAction(env, actorEmail, "개인 AI 한도 해제", email);
    }
    await setUserLimits(env, limits);
    return jsonResponse(200, { limits }, cors);
  }

  return jsonResponse(400, { error: "알 수 없는 action입니다." }, cors);
}

// 관리 페이지 전용: 최근 관리 활동 로그 조회 — 오너만 가능.
async function handleManagementLog(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  if (!payload.idToken) return jsonResponse(400, { error: "로그인 정보가 필요합니다." }, cors);

  const { role } = await checkRole(payload.idToken, env);
  if (role !== "owner") return jsonResponse(403, { error: "오너만 볼 수 있습니다." }, cors);

  return jsonResponse(200, { log: await getAdminLog(env) }, cors);
}

async function handlePrAction(request, env) {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" }, cors);

  const githubToken = env.GITHUB_TOKEN;
  const ownerEmail = env.OWNER_EMAIL;
  if (!githubToken || !ownerEmail) {
    return jsonResponse(500, { error: "서버에 GITHUB_TOKEN 또는 OWNER_EMAIL이 설정되지 않았습니다." }, cors);
  }

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }, cors); }
  const { idToken, prNumber, action } = payload;
  if (!idToken || !prNumber || !["approve", "reject"].includes(action)) {
    return jsonResponse(400, { error: "필요한 값이 없습니다." }, cors);
  }

  const { email: actorEmail, role } = await checkRole(idToken, env);
  if (!role) {
    return jsonResponse(403, { error: "이 작업을 수행할 권한이 없습니다." }, cors);
  }

  const ghHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "putreceipt-preview",
  };

  try {
    if (action === "approve") {
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}/merge`, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify({ merge_method: "merge" }),
      });
      const data = await res.json();
      if (!res.ok) return jsonResponse(502, { error: data?.message || "병합에 실패했습니다." }, cors);
      await logAdminAction(env, actorEmail, "업데이트 승인", `PR #${prNumber}`);
      return jsonResponse(200, { ok: true, merged: true }, cors);
    }

    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: ghHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    const data = await res.json();
    if (!res.ok) return jsonResponse(502, { error: data?.message || "PR 닫기에 실패했습니다." }, cors);
    await logAdminAction(env, actorEmail, "업데이트 거부", `PR #${prNumber}`);
    return jsonResponse(200, { ok: true, closed: true }, cors);
  } catch {
    return jsonResponse(502, { error: "GitHub 호출에 실패했습니다." }, cors);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ai-chat") return handleAiChat(request, env);
    if (url.pathname === "/api/pr-action") return handlePrAction(request, env);
    if (url.pathname === "/api/preview-status") return handlePreviewStatus(request, env);
    if (url.pathname === "/api/access-status") return handleAccessStatus(request, env);
    if (url.pathname === "/api/management/managers") return handleManagementManagers(request, env);
    if (url.pathname === "/api/management/banned") return handleManagementBanned(request, env);
    if (url.pathname === "/api/management/settings") return handleManagementSettings(request, env);
    if (url.pathname === "/api/management/users") return handleManagementUsers(request, env);
    if (url.pathname === "/api/notices") return handleNotices(request, env);
    if (url.pathname === "/api/management/notices") return handleManagementNotices(request, env);
    if (url.pathname === "/api/management/user-limits") return handleManagementUserLimits(request, env);
    if (url.pathname === "/api/management/log") return handleManagementLog(request, env);
    return env.ASSETS.fetch(request);
  },
};
