import { auth, authPersistenceReady } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { pendingUpdate } from "./data.js";

// 항상 같은 오리진(현재 페이지를 서빙하는 Worker)으로 호출합니다. 예전엔 lagem1535 계정의
// workers.dev 주소를 절대경로로 하드코딩했는데, 이러면 다른 도메인(ramalok.kr 등)에서
// 열었을 때 실제 브라우저 크로스오리진 요청이 되어 그 워커의 ALLOWED_ORIGINS에 없는 한
// CORS로 막힙니다. 상대경로로 두면 무조건 지금 페이지를 서빙 중인 Worker로 가서 안전합니다.
const API_BASE = "";

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
