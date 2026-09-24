// AI 검색: 오픈소스 임베딩 모델을 브라우저에서 직접 실행합니다 (가볍고, 최초 1회만 다운로드).
// AI 요약·채팅(문장 생성)은 메모리를 많이 써서 저사양 기기에서 브라우저 탭이 통째로
// 강제 종료(Out of Memory)되는 문제가 있어, 서버(Netlify Functions)가 대신 Gemini
// 무료 API를 호출합니다. API 키는 서버에만 있고, 하루 사용 횟수는 계정별로 제한됩니다.
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.4";
const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
// (Netlify 무료 크레딧이 소진되어 Cloudflare Workers로 옮겼습니다.)
const AI_ENDPOINT = "https://putreceipt.lagem1535.workers.dev/api/ai-chat";

let transformersMod = null;
let embedderPromise = null;

async function loadTransformers() {
  if (transformersMod) return transformersMod;
  transformersMod = await import(TRANSFORMERS_CDN);
  return transformersMod;
}

export function isSupported() {
  return typeof WebAssembly !== "undefined";
}

// progressCb(percent:0-100, label:string) — 모델 다운로드 진행률 표시용 (선택)
export async function getEmbedder(progressCb) {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await loadTransformers();
      return pipeline("feature-extraction", EMBED_MODEL, {
        dtype: "q8",
        progress_callback: (info) => {
          if (progressCb && info?.status === "progress") progressCb(Math.round(info.progress || 0), "임베딩 모델");
        },
      });
    })();
  }
  return embedderPromise;
}

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 문장/구(query)들을 임베딩 벡터로 변환합니다. 실패 시 예외를 던집니다(호출부에서 폴백 처리).
export async function embedTexts(texts, progressCb) {
  const extractor = await getEmbedder(progressCb);
  const list = Array.isArray(texts) ? texts : [texts];
  const output = await extractor(list.map(t => `query: ${t}`), { pooling: "mean", normalize: true });
  const dims = output.dims;
  const vectors = [];
  const data = output.data;
  const size = dims[dims.length - 1];
  for (let i = 0; i < list.length; i++) vectors.push(Array.from(data.slice(i * size, (i + 1) * size)));
  return Array.isArray(texts) ? vectors : vectors[0];
}

const TABLE_HINT = "표로 정리하면 더 명확한 내용(카테고리별 지출, 여러 건 비교 등)은 마크다운 표(| 헤더 | ... |)를 사용해서 답하세요.";

// Gemini 무료 API 자체의 분당 요청 한도(RPM)에 걸렸을 때 나오는 영문 오류를 한국어로 바꿔줍니다.
function friendlyError(raw) {
  if (!raw) return raw;
  if (/exceeded your current quota|Quota exceeded/i.test(raw)) {
    const m = /retry in ([\d.]+)s/i.exec(raw);
    const secs = m ? Math.ceil(parseFloat(m[1])) : null;
    return secs
      ? `Google 무료 API 사용량 제한(분당 요청 횟수)에 걸렸습니다. 약 ${secs}초 후 다시 시도해주세요.`
      : "Google 무료 API 사용량 제한(분당 요청 횟수)에 걸렸습니다. 잠시 후 다시 시도해주세요.";
  }
  return raw;
}

// auth = { uid, idToken } — 로그인한 사용자의 Firebase uid/ID 토큰 (서버가 하루 사용량을 확인하는 데 씀)
// tier: "low" | "medium" | "high" | "extreme" — 실제 모델명은 서버에만 있고 등급만 전달합니다.
// onDelta(chunkText, fullTextSoFar) — 실시간 스트리밍 표시용 콜백 (선택)
// confirmedAction({name, args}) — 사용자가 방금 승인한, 서버가 실행해야 할 함수 호출(선택).
async function callAiServer(messages, auth, tier, onDelta, confirmedAction) {
  let res;
  try {
    res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, uid: auth?.uid, idToken: auth?.idToken, tier, ...(confirmedAction ? { confirmedAction } : {}) }),
    });
  } catch {
    throw new Error("AI 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.");
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(friendlyError(data?.error) || `AI 서버 오류 (${res.status})`);
    const text = String(data?.reply || "").trim();
    if (text) onDelta?.(text, text);
    return { text, remaining: data?.remaining, tokens: data?.totalTokens };
  }
  if (!res.ok || !res.body) throw new Error(`AI 서버 오류 (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let remaining, tokens, confirmRequired;
  const actionResults = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 중간에 CRLF로 정규화되는 경우를 대비해 \r\n을 \n으로 맞춰줍니다.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = rawEvent.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.error) throw new Error(friendlyError(evt.error));
      if (evt.delta) { fullText += evt.delta; onDelta?.(evt.delta, fullText); }
      if (evt.actionResult) actionResults.push(evt.actionResult);
      if (evt.confirmRequired) confirmRequired = evt.confirmRequired;
      if (evt.done) { remaining = evt.remaining; tokens = evt.totalTokens; }
    }
  }
  // confirmRequired로 끝난 턴은 텍스트 없이 끝나는 게 정상이라, 이 경우에는 예외를 던지지 않습니다.
  if (!confirmRequired && !fullText.trim()) throw new Error("AI가 응답을 생성하지 못했습니다. 다시 시도해주세요.");
  return { text: fullText.trim(), remaining, tokens, confirmRequired, actionResults };
}

// 지출 통계를 바탕으로 자연스러운 한국어 요약 문단을 생성합니다.
export async function summarizeExpenses(stats, auth, tier, onDelta) {
  const topCategory = stats.byCategory?.[0];
  const userPrompt = `아래 지출 데이터를 바탕으로 경비 정산 보고서에 들어갈 한국어 요약을 2~3문장으로 작성해줘. 숫자는 그대로 사용하고, 과장하지 말고 사실만 담백하게 써줘.\n\n기간: ${stats.from} ~ ${stats.to}\n총 지출: ${stats.total}원\n영수증 수: ${stats.count}건\n평균 결제 금액: ${stats.avg}원\n가장 지출이 큰 카테고리: ${topCategory ? `${topCategory.c} (${topCategory.v}원)` : "없음"}`;
  const messages = [
    { role: "system", content: "당신은 회사 경비 정산 담당자를 돕는 한국어 비서입니다. 간결하고 정확한 요약만 작성합니다." },
    { role: "user", content: userPrompt },
  ];
  return callAiServer(messages, auth, tier, onDelta);
}

// 사용자의 영수증 목록을 근거로 질문에 답합니다. history는 [{role,content}, ...] 최근 대화 몇 턴.
// confirmedAction — 직전 턴에서 AI가 제안한 영수증 등록/삭제를 사용자가 방금 승인했을 때 전달합니다.
export async function chatAboutReceipts(question, receipts, history, auth, tier, onDelta, confirmedAction) {
  const capped = receipts.slice(0, 300);
  const lines = capped.map(r => `${r.date || "?"} ${r.store || "?"} · ${r.category || "기타"} · ${Number(r.amount || 0).toLocaleString("ko-KR")}원${r.paymentMethod ? ` · ${r.paymentMethod}` : ""}`).join("\n");
  const note = receipts.length > capped.length ? `\n(가장 최근 ${capped.length}건만 표시됨, 전체 ${receipts.length}건 중 일부)` : "";
  const systemPrompt = `당신은 사용자의 영수증 데이터를 바탕으로 지출 질문에 답하고, 요청이 있으면 영수증을 등록·수정·삭제할 수도 있는 한국어 비서입니다. 금액이나 가게명, 날짜 등을 정정해달라고 하면 edit_receipt로 수정하세요(새로 등록하고 기존 걸 지우는 대신). 지출 질문은 아래 영수증 목록만 근거로 답하고, 목록에서 확인할 수 없는 내용은 추측하지 말고 모른다고 답하세요. 숫자는 정확히 계산해서 답하세요. ${TABLE_HINT}\n\n영수증 목록:\n${lines}${note}`;
  const messages = [
    { role: "system", content: systemPrompt },
    ...(history || []),
    { role: "user", content: question },
  ];
  return callAiServer(messages, auth, tier, onDelta, confirmedAction);
}
