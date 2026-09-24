import { auth, db, authPersistenceReady } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { ref, onValue, push, set, update, remove } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { chatAboutReceipts } from "../ai/engine.js?v=7";

// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
const API_BASE = "https://putreceipt.lagem1535.workers.dev";

const $ = (selector) => document.querySelector(selector);
const DEFAULT_SETTINGS = { aiEnabled: false, aiTier: "medium" };

let currentUser = null;
let dailyTokenLimit = 50000; // 관리 페이지에서 조정 가능한 값이라, 로그인 시 서버에서 실제 값을 받아옵니다.
let lastUsedTokens = 0;
let settings = { ...DEFAULT_SETTINGS };
let receipts = [];
let conversations = [];
let messages = [];
let activeConvId = null;
let stopReceipts = null;
let stopConvMeta = null;
let stopMessages = null;
let sending = false;
let selectedTier = DEFAULT_SETTINGS.aiTier;
let tierManuallySet = false;
let thinkingActive = false;
let streamingText = "";
let pendingAssistantKey = null;
let pendingConfirm = null; // { name, args, question, history, convId } — AI가 실행 확인을 기다리는 동작

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

function inlineMd(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// 마크다운 표(| a | b |)와 굵게(**)만 지원하는 가벼운 렌더러. 그 외는 문단/줄바꿈으로 표시합니다.
function renderMarkdownLite(text) {
  const blocks = String(text || "").split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    const isTable = lines.length >= 2 && lines[0].trim().startsWith("|") && /^\|?[\s:-]+\|[\s|:-]*$/.test(lines[1].trim());
    if (isTable) {
      const rows = lines.filter((_, i) => i !== 1).map(line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
      const [headerRow, ...bodyRows] = rows;
      const thead = `<tr>${headerRow.map(c => `<th>${inlineMd(c)}</th>`).join("")}</tr>`;
      const tbody = bodyRows.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("");
      return `<div class="chat-table-wrap"><table class="chat-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
    }
    return `<p>${lines.map(inlineMd).join("<br>")}</p>`;
  }).join("");
}

function applyAiVisibility() {
  $("#aiDisabledNotice")?.classList.toggle("hidden", !!settings.aiEnabled);
  $("#aiChatCard")?.classList.toggle("hidden", !settings.aiEnabled);
}

function setTier(tier) {
  selectedTier = tier;
  document.querySelectorAll(".tier-btn").forEach(b => b.classList.toggle("active", b.dataset.tier === tier));
}

function renderConvList() {
  const el = $("#convList"); if (!el) return;
  el.innerHTML = conversations.length
    ? conversations.map(c => `<li class="conv-item ${c.id === activeConvId ? "active" : ""}" data-id="${c.id}"><span class="conv-item-title">${escapeHtml(c.title || "새 대화")}</span><button class="conv-item-del" data-id="${c.id}" type="button" aria-label="삭제">×</button></li>`).join("")
    : `<li class="conv-empty">대화 기록이 없어요.</li>`;
}

function describePendingAction({ name, args }) {
  if (name === "add_receipt") {
    const parts = [args.store, args.amount != null ? `${Number(args.amount).toLocaleString("ko-KR")}원` : null, args.category].filter(Boolean);
    return `${parts.join(" · ")} 영수증을 등록할까요?`;
  }
  if (name === "delete_receipt") {
    const parts = [args.store, args.amount != null ? `${Number(args.amount).toLocaleString("ko-KR")}원` : null, args.date].filter(Boolean);
    return `${parts.join(" · ")} 영수증을 삭제할까요?`;
  }
  if (name === "edit_receipt") {
    const target = [args.store, args.amount != null ? `${Number(args.amount).toLocaleString("ko-KR")}원` : null, args.date].filter(Boolean).join(" · ");
    const changes = [
      args.newStore != null ? `가게명 → ${args.newStore}` : null,
      args.newAmount != null ? `금액 → ${Number(args.newAmount).toLocaleString("ko-KR")}원` : null,
      args.newCategory != null ? `카테고리 → ${args.newCategory}` : null,
      args.newDate != null ? `날짜 → ${args.newDate}` : null,
      args.newItem != null ? `상품명 → ${args.newItem}` : null,
      args.newPaymentMethod != null ? `결제수단 → ${args.newPaymentMethod}` : null,
    ].filter(Boolean).join(", ");
    return `${target} 영수증을 수정할까요? (${changes})`;
  }
  return "이 작업을 실행할까요?";
}

function renderMessages() {
  const el = $("#chatMessages"); if (!el) return;
  const parts = [];
  for (const m of messages) {
    parts.push(m.role === "user"
      ? `<div class="chat-bubble chat-user">${escapeHtml(m.content)}</div>`
      : `<div class="chat-bubble chat-assistant">${renderMarkdownLite(m.content)}</div>`);
  }
  if (pendingConfirm) {
    parts.push(`<div class="chat-confirm-card"><p>${escapeHtml(describePendingAction(pendingConfirm))}</p><div class="chat-confirm-actions"><button id="chatConfirmYes" type="button" class="chat-confirm-yes">예</button><button id="chatConfirmNo" type="button" class="chat-confirm-no">아니오</button></div></div>`);
  } else if (thinkingActive) {
    parts.push(streamingText
      ? `<div class="chat-bubble chat-assistant" id="streamingBubble">${escapeHtml(streamingText).replace(/\n/g, "<br>")}</div>`
      : `<div class="chat-thinking" id="streamingBubble"><span></span><span></span><span></span></div>`);
  }
  el.innerHTML = parts.length ? parts.join("") : `<div class="chat-empty">아직 대화가 없어요. 지출에 대해 물어보세요.</div>`;
  el.scrollTop = el.scrollHeight;
}

function updateStreamingBubble() {
  const bubble = document.getElementById("streamingBubble");
  if (!bubble) { renderMessages(); return; }
  bubble.className = "chat-bubble chat-assistant";
  bubble.id = "streamingBubble";
  bubble.innerHTML = escapeHtml(streamingText).replace(/\n/g, "<br>");
  const container = $("#chatMessages");
  if (container) container.scrollTop = container.scrollHeight;
}

function setChatStatus(text) {
  const el = $("#chatStatus"); if (!el) return;
  if (!text) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.textContent = text;
}

function renderUsage(tokensUsedToday) {
  lastUsedTokens = tokensUsedToday;
  const pct = Math.min(100, Math.round((tokensUsedToday / dailyTokenLimit) * 100));
  const fill = $("#chatUsageFill"); if (fill) fill.style.width = `${pct}%`;
  const text = $("#chatUsageText");
  if (text) text.textContent = `오늘 ${tokensUsedToday.toLocaleString("ko-KR")} / ${dailyTokenLimit.toLocaleString("ko-KR")} 토큰`;
}

function subscribeMessages(convId) {
  if (stopMessages) stopMessages();
  stopMessages = onValue(ref(db, `users/${currentUser.uid}/aiChat/convMessages/${convId}`), snapshot => {
    const data = snapshot.val() || {};
    messages = Object.entries(data).map(([id, m]) => ({ id, ...(m || {}) })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (pendingAssistantKey && messages.some(m => m.id === pendingAssistantKey)) {
      pendingAssistantKey = null;
      thinkingActive = false;
      streamingText = "";
    }
    renderMessages();
  });
}

async function createConversation() {
  const convRef = push(ref(db, `users/${currentUser.uid}/aiChat/convMeta`));
  await set(convRef, { title: "새 대화", createdAt: Date.now(), updatedAt: Date.now() });
  activeConvId = convRef.key;
  subscribeMessages(activeConvId);
  renderConvList();
}

async function switchConversation(convId) {
  activeConvId = convId;
  subscribeMessages(convId);
  renderConvList();
  $("#convList")?.classList.add("hidden");
}

async function deleteConversation(convId) {
  if (!window.confirm("이 대화를 삭제할까요?")) return;
  try {
    await remove(ref(db, `users/${currentUser.uid}/aiChat/convMeta/${convId}`));
    await remove(ref(db, `users/${currentUser.uid}/aiChat/convMessages/${convId}`));
    if (activeConvId === convId) {
      const next = conversations.find(c => c.id !== convId);
      if (next) { activeConvId = next.id; subscribeMessages(activeConvId); }
      else {
        activeConvId = null;
        if (stopMessages) stopMessages();
        stopMessages = null;
        messages = [];
        renderMessages();
      }
    }
  } catch (error) {
    window.alert(`대화 삭제에 실패했습니다.\n${error.message || ""}`);
  }
}

async function sendMessage() {
  if (sending || !currentUser || !settings.aiEnabled) return;
  const input = $("#chatInput");
  const question = input?.value.trim();
  if (!question) return;
  sending = true;
  const sendBtn = $("#chatSendBtn"); if (sendBtn) sendBtn.disabled = true;
  if (input) input.value = "";

  try {
    if (!activeConvId) await createConversation();
    const convId = activeConvId;
    const isFirstMessage = messages.length === 0;
    // 질문을 저장하기 전에 history를 먼저 떠 둡니다. Firebase set()은 로컬 리스너가
    // 이미 갱신된 뒤에 완료되므로, 저장 후에 읽으면 방금 보낸 질문이 history에도
    // 중복으로 들어가 Gemini에 같은 질문이 연속 두 번 전달되는 문제가 있었습니다.
    const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));

    await set(push(ref(db, `users/${currentUser.uid}/aiChat/convMessages/${convId}`)), { role: "user", content: question, ts: Date.now() });
    await update(ref(db, `users/${currentUser.uid}/aiChat/convMeta/${convId}`), {
      updatedAt: Date.now(),
      ...(isFirstMessage ? { title: question.slice(0, 24) } : {}),
    });

    thinkingActive = true; streamingText = "";
    renderMessages();
    setChatStatus("생각하는 중...");

    const idToken = await currentUser.getIdToken();
    const result = await chatAboutReceipts(question, receipts, history, { uid: currentUser.uid, idToken }, selectedTier, (chunk, full) => {
      streamingText = full;
      updateStreamingBubble();
    });

    if (result.confirmRequired) {
      thinkingActive = false; streamingText = "";
      pendingConfirm = { ...result.confirmRequired, question, history: [...history, { role: "user", content: question }], convId };
      renderMessages();
      setChatStatus("");
    } else if (result.text) {
      const pushedRef = push(ref(db, `users/${currentUser.uid}/aiChat/convMessages/${convId}`));
      pendingAssistantKey = pushedRef.key;
      await set(pushedRef, { role: "assistant", content: result.text, ts: Date.now() });
      await update(ref(db, `users/${currentUser.uid}/aiChat/convMeta/${convId}`), { updatedAt: Date.now() });
      setChatStatus(result.tokens != null ? `이번 응답: ${result.tokens.toLocaleString("ko-KR")} 토큰 사용` : "");
    } else {
      thinkingActive = false; streamingText = "";
      renderMessages();
    }
  } catch (error) {
    console.error(error);
    thinkingActive = false; streamingText = "";
    renderMessages();
    setChatStatus(`답변을 가져오지 못했습니다. (${error.message || "잠시 후 다시 시도해주세요"})`);
  } finally {
    sending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function confirmPendingAction() {
  if (!pendingConfirm || sending) return;
  const action = pendingConfirm;
  pendingConfirm = null;
  sending = true;
  const sendBtn = $("#chatSendBtn"); if (sendBtn) sendBtn.disabled = true;
  thinkingActive = true; streamingText = "";
  renderMessages();
  setChatStatus("실행하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const result = await chatAboutReceipts(action.question, receipts, action.history, { uid: currentUser.uid, idToken }, selectedTier, (chunk, full) => {
      streamingText = full;
      updateStreamingBubble();
    }, { name: action.name, args: action.args });

    if (result.confirmRequired) {
      thinkingActive = false; streamingText = "";
      pendingConfirm = { ...result.confirmRequired, question: action.question, history: action.history, convId: action.convId };
      renderMessages();
      setChatStatus("");
    } else if (result.text) {
      const pushedRef = push(ref(db, `users/${currentUser.uid}/aiChat/convMessages/${action.convId}`));
      pendingAssistantKey = pushedRef.key;
      await set(pushedRef, { role: "assistant", content: result.text, ts: Date.now() });
      await update(ref(db, `users/${currentUser.uid}/aiChat/convMeta/${action.convId}`), { updatedAt: Date.now() });
      setChatStatus(result.tokens != null ? `이번 응답: ${result.tokens.toLocaleString("ko-KR")} 토큰 사용` : "");
    } else {
      thinkingActive = false; streamingText = "";
      renderMessages();
    }
  } catch (error) {
    console.error(error);
    thinkingActive = false; streamingText = "";
    renderMessages();
    setChatStatus(`실행에 실패했습니다. (${error.message || "잠시 후 다시 시도해주세요"})`);
  } finally {
    sending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}
function declinePendingAction() {
  if (!pendingConfirm) return;
  pendingConfirm = null;
  renderMessages();
  setChatStatus("취소했어요.");
}
$("#chatMessages")?.addEventListener("click", (event) => {
  if (event.target.closest("#chatConfirmYes")) confirmPendingAction();
  else if (event.target.closest("#chatConfirmNo")) declinePendingAction();
});

$("#chatSendBtn")?.addEventListener("click", sendMessage);
$("#chatInput")?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); sendMessage(); } });

$("#newConvBtn")?.addEventListener("click", () => { createConversation(); $("#convList")?.classList.add("hidden"); });
$("#toggleConvListBtn")?.addEventListener("click", () => $("#convList")?.classList.toggle("hidden"));
$("#convList")?.addEventListener("click", (event) => {
  const delBtn = event.target.closest(".conv-item-del");
  if (delBtn) { deleteConversation(delBtn.dataset.id); return; }
  const item = event.target.closest(".conv-item[data-id]");
  if (item) switchConversation(item.dataset.id);
});
$("#tierButtons")?.addEventListener("click", (event) => {
  const btn = event.target.closest(".tier-btn"); if (!btn) return;
  tierManuallySet = true;
  setTier(btn.dataset.tier);
});

async function handleLogout() { try { await authPersistenceReady; await signOut(auth); window.location.replace("../login/"); } catch (error) { window.alert(`로그아웃에 실패했습니다.\n${error.message || "잠시 후 다시 시도해주세요."}`); } }
$("#logoutBtn")?.addEventListener("click", handleLogout);
$("#mobileLogoutBtn")?.addEventListener("click", handleLogout);

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("../login/"); return; }
  currentUser = user;
  if (stopReceipts) stopReceipts();
  if (stopConvMeta) stopConvMeta();
  if (stopMessages) stopMessages();

  onValue(ref(db, `users/${user.uid}/settings`), snapshot => {
    settings = { ...DEFAULT_SETTINGS, ...(snapshot.val() || {}) };
    applyAiVisibility();
    if (!tierManuallySet) setTier(settings.aiTier || "medium");
  });

  stopReceipts = onValue(ref(db, `users/${user.uid}/receipts`), snapshot => {
    const data = snapshot.val() || {};
    receipts = Object.entries(data).map(([id, r]) => ({ id, ...(r || {}) })).sort((a, b) => `${b.date}${b.time||""}`.localeCompare(`${a.date}${a.time||""}`));
  });

  stopConvMeta = onValue(ref(db, `users/${user.uid}/aiChat/convMeta`), snapshot => {
    const data = snapshot.val() || {};
    conversations = Object.entries(data).map(([id, c]) => ({ id, ...(c || {}) })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!activeConvId && conversations.length) { activeConvId = conversations[0].id; subscribeMessages(activeConvId); }
    renderConvList();
  });

  const today = new Date().toISOString().slice(0, 10);
  onValue(ref(db, `users/${user.uid}/aiUsage/${today}`), snapshot => {
    renderUsage(snapshot.val() || 0);
  });

  user.getIdToken().then(idToken =>
    fetch(`${API_BASE}/api/access-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }).then(res => res.json())
  ).then(data => {
    if (data && Number.isFinite(data.dailyTokenLimit)) {
      dailyTokenLimit = data.dailyTokenLimit;
      renderUsage(lastUsedTokens);
    }
  }).catch(() => { /* 한도 조회 실패 시 기본값(50000)으로 계속 동작 */ });

  renderMessages();
});
