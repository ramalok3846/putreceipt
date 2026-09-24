import { auth, db, authPersistenceReady } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { ref, onValue, push, set } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const $ = (selector) => document.querySelector(selector);
const DEFAULT_SETTINGS = { updatesEnabled: true };
let currentUser = null;
let changelog = [];
let openVersion = null;
let updatesEnabled = true;
const commentStops = {};

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

function formatCommentDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function renderComments(version) {
  const list = document.querySelector(`.update-comment-list[data-version="${version}"]`);
  if (!list) return;
  const comments = list._comments || [];
  list.innerHTML = comments.length
    ? comments.map(c => `<div class="update-comment">${escapeHtml(c.text)}<span class="update-comment-date">${formatCommentDate(c.ts)}</span></div>`).join("")
    : `<p class="update-comment-empty">아직 댓글이 없어요.</p>`;
}

function subscribeComments(version) {
  if (commentStops[version]) return;
  commentStops[version] = onValue(ref(db, `users/${currentUser.uid}/updateComments/${version}`), snapshot => {
    const data = snapshot.val() || {};
    const comments = Object.entries(data).map(([id, c]) => ({ id, ...(c || {}) })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const list = document.querySelector(`.update-comment-list[data-version="${version}"]`);
    if (list) list._comments = comments;
    renderComments(version);
  });
}

async function addComment(version, text) {
  if (!text.trim() || !currentUser) return;
  try {
    await set(push(ref(db, `users/${currentUser.uid}/updateComments/${version}`)), { text: text.trim(), ts: Date.now() });
  } catch (error) {
    window.alert(`댓글 등록에 실패했습니다.\n${error.message || ""}`);
  }
}

function renderUpdateList() {
  const el = $("#updateList"); if (!el) return;
  el.innerHTML = changelog.map((item, i) => {
    const isOpen = openVersion === null ? i === 0 : openVersion === item.version;
    const images = (item.images || []).map(src => `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}">`).join("");
    return `
      <section class="content-card update-item ${isOpen ? "open" : ""}" data-version="${escapeHtml(item.version)}">
        <button class="update-item-header" data-version="${escapeHtml(item.version)}" type="button">
          <div>
            <span class="update-version">v${escapeHtml(item.version)}</span>
            <h3 class="update-title">${escapeHtml(item.title)}</h3>
            <span class="update-date">${escapeHtml(item.publishedAt || "")}</span>
          </div>
          <span class="update-caret">▾</span>
        </button>
        <div class="update-body ${isOpen ? "" : "hidden"}">
          <ul class="update-features">${(item.features || []).map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
          ${images ? `<div class="update-images">${images}</div>` : ""}
          <div class="update-comments">
            <h4>댓글</h4>
            <div class="update-comment-list" data-version="${escapeHtml(item.version)}"></div>
            <div class="update-comment-input-row">
              <input type="text" data-version="${escapeHtml(item.version)}" placeholder="이 업데이트에 대한 생각을 남겨보세요">
              <button type="button" data-version="${escapeHtml(item.version)}">등록</button>
            </div>
          </div>
        </div>
      </section>`;
  }).join("");

  if (updatesEnabled) {
    changelog.forEach(item => {
      subscribeComments(item.version);
      renderComments(item.version);
    });
  }
}

$("#updateList")?.addEventListener("click", (event) => {
  const header = event.target.closest(".update-item-header");
  if (header) {
    const version = header.dataset.version;
    openVersion = openVersion === version ? "" : version;
    renderUpdateList();
    return;
  }
  const btn = event.target.closest(".update-comment-input-row button");
  if (btn) {
    const version = btn.dataset.version;
    const input = document.querySelector(`.update-comment-input-row input[data-version="${version}"]`);
    if (input) { addComment(version, input.value); input.value = ""; }
  }
});
$("#updateList")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target.closest(".update-comment-input-row input");
  if (!input) return;
  event.preventDefault();
  addComment(input.dataset.version, input.value);
  input.value = "";
});

async function loadChangelog() {
  try {
    const res = await fetch("./changelog.json");
    changelog = await res.json();
    renderUpdateList();
  } catch (error) {
    const el = $("#updateList");
    if (el) el.innerHTML = `<p class="settings-desc">업데이트 목록을 불러오지 못했습니다.</p>`;
  }
}

function applyVisibility(enabled) {
  updatesEnabled = enabled;
  $("#updatesDisabledNotice")?.classList.toggle("hidden", !!enabled);
  $("#updateList")?.classList.toggle("hidden", !enabled);
  if (enabled && changelog.length) renderUpdateList();
}

async function handleLogout() { try { await authPersistenceReady; await signOut(auth); window.location.replace("../login/"); } catch (error) { window.alert(`로그아웃에 실패했습니다.\n${error.message || "잠시 후 다시 시도해주세요."}`); } }
$("#logoutBtn")?.addEventListener("click", handleLogout);
$("#mobileLogoutBtn")?.addEventListener("click", handleLogout);

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.replace("../login/"); return; }
  currentUser = user;
  onValue(ref(db, `users/${user.uid}/settings`), snapshot => {
    const settings = { ...DEFAULT_SETTINGS, ...(snapshot.val() || {}) };
    applyVisibility(settings.updatesEnabled !== false);
  });
  loadChangelog();
});
