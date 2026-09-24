import { auth, authPersistenceReady } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { pendingUpdate } from "./data.js";

// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
const API_BASE = "https://putreceipt.lagem1535.workers.dev";

const $ = (selector) => document.querySelector(selector);
let currentUser = null;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

function showNoAccess() {
  $("#previewNoAccessNotice")?.classList.remove("hidden");
  $("#previewHeaderCard")?.classList.add("hidden");
  $("#previewNoneNotice")?.classList.add("hidden");
  $("#previewCard")?.classList.add("hidden");
}

function render() {
  $("#previewNoAccessNotice")?.classList.add("hidden");
  $("#previewHeaderCard")?.classList.remove("hidden");
  if (!pendingUpdate) {
    $("#previewNoneNotice")?.classList.remove("hidden");
    $("#previewCard")?.classList.add("hidden");
    return;
  }
  if ($("#previewTitle")) $("#previewTitle").textContent = pendingUpdate.title || "업데이트 미리보기";
  if ($("#previewSummary")) $("#previewSummary").textContent = pendingUpdate.summary || "";
  if ($("#previewFeatures")) $("#previewFeatures").innerHTML = (pendingUpdate.features || []).map(f => `<li>${escapeHtml(f)}</li>`).join("");
  if ($("#previewImages")) $("#previewImages").innerHTML = (pendingUpdate.images || []).map(src => `<img src="${escapeHtml(src)}" alt="">`).join("");
  $("#previewCard")?.classList.remove("hidden");
}

async function checkAccessAndRender() {
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/api/preview-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authorized) { showNoAccess(); return; }
    render();
  } catch {
    showNoAccess();
  }
}

function setStatus(text, error = false) {
  const el = $("#previewStatus"); if (!el) return;
  if (!text) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.textContent = text;
  el.style.color = error ? "#e0245e" : "";
}

async function callAction(action) {
  if (!currentUser || !pendingUpdate) return;
  const approveBtn = $("#approveBtn"), rejectBtn = $("#rejectBtn");
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;
  setStatus(action === "approve" ? "병합하는 중..." : "닫는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/api/pr-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, prNumber: pendingUpdate.prNumber, action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `오류 (${res.status})`);
    setStatus(action === "approve" ? "승인되어 병합되었습니다. 곧 실제 서비스에 반영돼요." : "거부되어 PR을 닫았습니다.");
  } catch (error) {
    setStatus(`실패했습니다. (${error.message || ""})`, true);
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
  }
}

$("#approveBtn")?.addEventListener("click", () => callAction("approve"));
$("#rejectBtn")?.addEventListener("click", () => callAction("reject"));

async function handleLogout() { try { await authPersistenceReady; await signOut(auth); window.location.replace("../login/"); } catch (error) { window.alert(`로그아웃에 실패했습니다.\n${error.message || "잠시 후 다시 시도해주세요."}`); } }
$("#logoutBtn")?.addEventListener("click", handleLogout);

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("../login/"); return; }
  currentUser = user;
  checkAccessAndRender();
});
