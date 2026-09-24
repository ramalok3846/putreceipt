import { auth, authPersistenceReady } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { buildAnnouncementCard } from "../shared/notices.js?v=5";

// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
const API_BASE = "https://putreceipt.lagem1535.workers.dev";

const $ = (selector) => document.querySelector(selector);
let currentUser = null;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

function formatDate(ms) { return ms ? new Date(ms).toLocaleString("ko-KR") : "-"; }

function showNoAccess() {
  $("#mgmtNoAccessNotice")?.classList.remove("hidden");
  $("#mgmtRoot")?.classList.add("hidden");
}

async function callApi(idToken, path, extra = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `오류 (${res.status})`);
  return data;
}

function setStatus(el, text, error = false) {
  if (!el) return;
  if (!text) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.textContent = text;
  el.style.color = error ? "#e0245e" : "";
}

function renderEmailList(ul, emails, onRemove) {
  if (!ul) return;
  ul.innerHTML = emails.length
    ? emails.map(email => `<li><span>${escapeHtml(email)}</span><button class="mgmt-remove-btn" type="button" data-email="${escapeHtml(email)}">삭제</button></li>`).join("")
    : "<li>없음</li>";
  ul.querySelectorAll(".mgmt-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => onRemove(btn.dataset.email));
  });
}

// --- 매니저 ---
async function loadManagers() {
  const idToken = await currentUser.getIdToken();
  const data = await callApi(idToken, "/api/management/managers", { action: "list" });
  if ($("#mgmtOwnerList")) $("#mgmtOwnerList").innerHTML = data.owner ? `<li>${escapeHtml(data.owner)}</li>` : "<li>설정되지 않음</li>";
  renderEmailList($("#mgmtManagerList"), data.list, removeManager);
}
async function addManager() {
  const input = $("#mgmtManagerAddInput");
  const email = input?.value.trim();
  if (!email) return;
  setStatus($("#mgmtManagerStatus"), "추가하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/managers", { action: "add", email });
    renderEmailList($("#mgmtManagerList"), data.list, removeManager);
    if (input) input.value = "";
    setStatus($("#mgmtManagerStatus"), "추가되었습니다.");
  } catch (error) {
    setStatus($("#mgmtManagerStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}
async function removeManager(email) {
  setStatus($("#mgmtManagerStatus"), "삭제하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/managers", { action: "remove", email });
    renderEmailList($("#mgmtManagerList"), data.list, removeManager);
    setStatus($("#mgmtManagerStatus"), "삭제되었습니다.");
  } catch (error) {
    setStatus($("#mgmtManagerStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}

// --- 차단된 이메일 ---
async function loadBanned() {
  const idToken = await currentUser.getIdToken();
  const data = await callApi(idToken, "/api/management/banned", { action: "list" });
  renderEmailList($("#mgmtBannedList"), data.list, removeBanned);
}
async function addBanned() {
  const input = $("#mgmtBannedAddInput");
  const email = input?.value.trim();
  if (!email) return;
  setStatus($("#mgmtBannedStatus"), "차단하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/banned", { action: "add", email });
    renderEmailList($("#mgmtBannedList"), data.list, removeBanned);
    if (input) input.value = "";
    setStatus($("#mgmtBannedStatus"), "차단되었습니다.");
  } catch (error) {
    setStatus($("#mgmtBannedStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}
async function removeBanned(email) {
  setStatus($("#mgmtBannedStatus"), "해제하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/banned", { action: "remove", email });
    renderEmailList($("#mgmtBannedList"), data.list, removeBanned);
    setStatus($("#mgmtBannedStatus"), "차단이 해제되었습니다.");
  } catch (error) {
    setStatus($("#mgmtBannedStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}

// --- AI 설정 ---
async function loadLimit() {
  const idToken = await currentUser.getIdToken();
  const data = await callApi(idToken, "/api/management/settings", { action: "get" });
  if ($("#mgmtLimitInput")) $("#mgmtLimitInput").value = data.dailyTokenLimit;
}
async function saveLimit() {
  const input = $("#mgmtLimitInput");
  const value = Number(input?.value);
  if (!Number.isFinite(value) || value <= 0) {
    setStatus($("#mgmtLimitStatus"), "1 이상의 숫자를 입력해주세요.", true);
    return;
  }
  setStatus($("#mgmtLimitStatus"), "저장하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/settings", { action: "set", dailyTokenLimit: value });
    if (input) input.value = data.dailyTokenLimit;
    setStatus($("#mgmtLimitStatus"), "저장되었습니다.");
  } catch (error) {
    setStatus($("#mgmtLimitStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}

// --- 상단 배너 ---
let bannerItemsDraft = [];
const BANNER_MAX_ITEMS = 5;

function renderBannerItems() {
  const ul = $("#mgmtBannerItemsList");
  if (!ul) return;
  ul.innerHTML = bannerItemsDraft.length
    ? bannerItemsDraft.map((text, i) => `<li><span>${escapeHtml(text)}</span><button class="mgmt-remove-btn" type="button" data-index="${i}">삭제</button></li>`).join("")
    : "<li>등록된 문구가 없어요.</li>";
  ul.querySelectorAll(".mgmt-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      bannerItemsDraft.splice(Number(btn.dataset.index), 1);
      renderBannerItems();
    });
  });
}
function addBannerItem() {
  const input = $("#mgmtBannerItemInput");
  const text = input?.value.trim();
  if (!text) return;
  if (bannerItemsDraft.length >= BANNER_MAX_ITEMS) {
    setStatus($("#mgmtBannerStatus"), `배너 문구는 최대 ${BANNER_MAX_ITEMS}개까지 추가할 수 있어요.`, true);
    return;
  }
  bannerItemsDraft.push(text);
  if (input) input.value = "";
  renderBannerItems();
}

async function loadBanner() {
  const idToken = await currentUser.getIdToken();
  const data = await callApi(idToken, "/api/management/notices", { action: "get" });
  if ($("#mgmtBannerEnabled")) $("#mgmtBannerEnabled").checked = !!data.banner?.enabled;
  if ($("#mgmtBannerSizeInput")) $("#mgmtBannerSizeInput").value = data.banner?.size || "medium";
  bannerItemsDraft = Array.isArray(data.banner?.items) ? [...data.banner.items] : [];
  renderBannerItems();
  if ($("#mgmtAnnouncementEnabled")) $("#mgmtAnnouncementEnabled").checked = !!data.announcement?.enabled;
  if ($("#mgmtAnnouncementTitleInput")) $("#mgmtAnnouncementTitleInput").value = data.announcement?.title || "";
  if ($("#mgmtAnnouncementBodyInput")) $("#mgmtAnnouncementBodyInput").value = data.announcement?.body || "";
  if ($("#mgmtAnnouncementColorInput")) $("#mgmtAnnouncementColorInput").value = data.announcement?.accentColor || "#6d3df2";
  if ($("#mgmtAnnouncementImageInput")) $("#mgmtAnnouncementImageInput").value = data.announcement?.imageUrl || "";
  if ($("#mgmtAnnouncementLinkUrlInput")) $("#mgmtAnnouncementLinkUrlInput").value = data.announcement?.linkUrl || "";
  if ($("#mgmtAnnouncementLinkTextInput")) $("#mgmtAnnouncementLinkTextInput").value = data.announcement?.linkText || "";
  updateAnnouncementPreview();
}
async function saveBanner() {
  setStatus($("#mgmtBannerStatus"), "저장하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/notices", {
      action: "setBanner",
      enabled: !!$("#mgmtBannerEnabled")?.checked,
      size: $("#mgmtBannerSizeInput")?.value || "medium",
      items: bannerItemsDraft,
    });
    bannerItemsDraft = Array.isArray(data.banner?.items) ? [...data.banner.items] : [];
    renderBannerItems();
    setStatus($("#mgmtBannerStatus"), "저장되었습니다.");
  } catch (error) {
    setStatus($("#mgmtBannerStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}
function currentAnnouncementDraft() {
  return {
    enabled: !!$("#mgmtAnnouncementEnabled")?.checked,
    title: $("#mgmtAnnouncementTitleInput")?.value.trim() || "",
    body: $("#mgmtAnnouncementBodyInput")?.value.trim() || "",
    accentColor: $("#mgmtAnnouncementColorInput")?.value || "#6d3df2",
    imageUrl: $("#mgmtAnnouncementImageInput")?.value.trim() || "",
    linkUrl: $("#mgmtAnnouncementLinkUrlInput")?.value.trim() || "",
    linkText: $("#mgmtAnnouncementLinkTextInput")?.value.trim() || "",
  };
}
function updateAnnouncementPreview() {
  const box = $("#mgmtAnnouncementPreview");
  if (!box) return;
  box.innerHTML = "";
  box.appendChild(buildAnnouncementCard(currentAnnouncementDraft()));
}
async function saveAnnouncement() {
  setStatus($("#mgmtAnnouncementStatus"), "게시하는 중...");
  try {
    const idToken = await currentUser.getIdToken();
    await callApi(idToken, "/api/management/notices", { action: "setAnnouncement", ...currentAnnouncementDraft() });
    setStatus($("#mgmtAnnouncementStatus"), "게시되었습니다. 사용자가 다음에 들어오면 다시 보여요.");
  } catch (error) {
    setStatus($("#mgmtAnnouncementStatus"), `실패했습니다. (${error.message || ""})`, true);
  }
}

// --- 사용자 현황 ---
let allUsers = [];

function renderUsers(users) {
  if (!$("#mgmtUsersBody")) return;
  $("#mgmtUsersBody").innerHTML = users.length
    ? users.map(u => `<tr>
        <td>${escapeHtml(u.email || u.uid)}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>${formatDate(u.lastLoginAt)}</td>
        <td>${u.loginCount}</td>
        <td>${u.receiptCount}</td>
        <td>${u.email ? renderLimitCell(u) : "-"}</td>
      </tr>`).join("")
    : `<tr><td colspan="6">검색 결과가 없어요.</td></tr>`;
  $("#mgmtUsersBody").querySelectorAll(".mgmt-set-limit-btn").forEach(btn => {
    btn.addEventListener("click", () => setUserLimit(btn.dataset.email, btn.closest(".mgmt-user-limit-cell").querySelector("input").value));
  });
  $("#mgmtUsersBody").querySelectorAll(".mgmt-clear-limit-btn").forEach(btn => {
    btn.addEventListener("click", () => clearUserLimit(btn.dataset.email));
  });
}

function renderLimitCell(u) {
  const email = escapeHtml(u.email);
  const current = u.dailyTokenLimit ? escapeHtml(String(u.dailyTokenLimit)) : "";
  const placeholder = u.dailyTokenLimit ? "" : "기본값";
  return `<div class="mgmt-user-limit-cell">
    <input type="number" inputmode="numeric" min="1" value="${current}" placeholder="${placeholder}" data-email="${email}">
    <button class="mgmt-set-limit-btn" type="button" data-email="${email}">저장</button>
    ${u.dailyTokenLimit ? `<button class="mgmt-clear-limit-btn" type="button" data-email="${email}">해제</button>` : ""}
  </div>`;
}

async function setUserLimit(email, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) { window.alert("1 이상의 숫자를 입력해주세요."); return; }
  try {
    const idToken = await currentUser.getIdToken();
    await callApi(idToken, "/api/management/user-limits", { action: "set", email, dailyTokenLimit: value });
    const u = allUsers.find(x => x.email === email);
    if (u) u.dailyTokenLimit = value;
    applyUserFilter();
  } catch (error) {
    window.alert(`실패했습니다.\n${error.message || ""}`);
  }
}
async function clearUserLimit(email) {
  try {
    const idToken = await currentUser.getIdToken();
    await callApi(idToken, "/api/management/user-limits", { action: "remove", email });
    const u = allUsers.find(x => x.email === email);
    if (u) u.dailyTokenLimit = null;
    applyUserFilter();
  } catch (error) {
    window.alert(`실패했습니다.\n${error.message || ""}`);
  }
}

function applyUserFilter() {
  const query = $("#mgmtUsersSearchInput")?.value.trim().toLowerCase() || "";
  const filtered = query ? allUsers.filter(u => (u.email || "").toLowerCase().includes(query)) : allUsers;
  renderUsers(filtered);
}

async function loadUsers() {
  const notice = $("#mgmtUsersNotice");
  const wrap = $("#mgmtUsersTableWrap");
  notice?.classList.add("hidden");
  wrap?.classList.add("hidden");
  try {
    const idToken = await currentUser.getIdToken();
    const data = await callApi(idToken, "/api/management/users");
    allUsers = data.users;
    applyUserFilter();
    wrap?.classList.remove("hidden");
  } catch (error) {
    if (notice) { notice.textContent = error.message || "사용자 정보를 불러오지 못했습니다."; notice.classList.remove("hidden"); }
  }
}

async function loadAll() {
  try {
    await loadManagers();
  } catch { showNoAccess(); return; }
  $("#mgmtNoAccessNotice")?.classList.add("hidden");
  $("#mgmtRoot")?.classList.remove("hidden");
  loadBanned().catch(() => {});
  loadLimit().catch(() => {});
  loadBanner().catch(() => {});
  loadUsers();
}

$("#mgmtManagerAddBtn")?.addEventListener("click", addManager);
$("#mgmtManagerAddInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addManager(); });
$("#mgmtBannedAddBtn")?.addEventListener("click", addBanned);
$("#mgmtBannedAddInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addBanned(); });
$("#mgmtLimitSaveBtn")?.addEventListener("click", saveLimit);
$("#mgmtBannerAddItemBtn")?.addEventListener("click", addBannerItem);
$("#mgmtBannerItemInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addBannerItem(); });
$("#mgmtBannerSaveBtn")?.addEventListener("click", saveBanner);
$("#mgmtAnnouncementSaveBtn")?.addEventListener("click", saveAnnouncement);
["mgmtAnnouncementEnabled", "mgmtAnnouncementTitleInput", "mgmtAnnouncementBodyInput", "mgmtAnnouncementColorInput", "mgmtAnnouncementImageInput", "mgmtAnnouncementLinkUrlInput", "mgmtAnnouncementLinkTextInput"]
  .forEach(id => $(`#${id}`)?.addEventListener("input", updateAnnouncementPreview));
$("#mgmtUsersRefreshBtn")?.addEventListener("click", loadUsers);
$("#mgmtUsersSearchInput")?.addEventListener("input", applyUserFilter);

async function handleLogout() { try { await authPersistenceReady; await signOut(auth); window.location.replace("../login/"); } catch (error) { window.alert(`로그아웃에 실패했습니다.\n${error.message || "잠시 후 다시 시도해주세요."}`); } }
$("#logoutBtn")?.addEventListener("click", handleLogout);

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("../login/"); return; }
  currentUser = user;
  loadAll();
});
