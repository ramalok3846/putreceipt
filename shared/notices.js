import { auth } from "../login/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
const API_BASE = "https://putreceipt.lagem1535.workers.dev";

function injectStyles() {
  if (document.getElementById("pr-notices-style")) return;
  const style = document.createElement("style");
  style.id = "pr-notices-style";
  style.textContent = `
.pr-banner{background:#6d3df2;color:#fff;font-weight:700;position:relative;line-height:1.4;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.pr-banner-small{padding:6px 44px 6px 16px;font-size:11px}
.pr-banner-medium{padding:10px 44px 10px 16px;font-size:13px}
.pr-banner-large{padding:16px 48px 16px 20px;font-size:15px}
.pr-banner-dots{display:flex;gap:5px;flex-shrink:0}
.pr-banner-dots span{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.4)}
.pr-banner-dots span.active{background:#fff}
.pr-banner-close{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:18px;cursor:pointer;opacity:.85;line-height:1;padding:4px}
.pr-banner-close:hover{opacity:1}
.pr-modal-overlay{position:fixed;inset:0;background:rgba(20,20,30,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}
.pr-modal-card{background:#fff;border-radius:16px;padding:26px;max-width:420px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25);box-sizing:border-box;border-top:5px solid var(--pr-accent,#6d3df2)}
.pr-modal-image{display:block;width:100%;max-height:180px;object-fit:cover;border-radius:10px;margin:-4px 0 16px}
.pr-modal-card h2{margin:0 0 10px;font-size:17px;color:#171827}
.pr-modal-card p{margin:0 0 20px;font-size:13px;line-height:1.7;color:#4b4d5c;white-space:pre-wrap}
.pr-modal-card p strong{color:#171827}
.pr-modal-btn{width:100%;height:46px;border:0;border-radius:10px;background:var(--pr-accent,#6d3df2);color:#fff;font-weight:800;cursor:pointer;font-size:13px;font-family:inherit}
.pr-modal-btn:hover{filter:brightness(0.92)}
.pr-modal-link{display:block;text-align:center;margin-top:12px;font-size:12px;font-weight:700;color:var(--pr-accent,#6d3df2);text-decoration:none}
.pr-modal-link:hover{text-decoration:underline}
.pr-admin-glow{position:fixed;inset:0;pointer-events:none;z-index:9997;box-shadow:inset 0 0 0 3px rgba(109,61,242,.6),inset 0 0 80px 16px rgba(109,61,242,.4);animation:prAdminGlowPulse 2.4s ease-in-out infinite alternate}
@keyframes prAdminGlowPulse{from{opacity:.35}to{opacity:1}}
.pr-admin-chip{position:fixed;right:14px;bottom:14px;z-index:9998;background:#6d3df2;color:#fff;font-size:11px;font-weight:850;padding:7px 13px;border-radius:999px;box-shadow:0 6px 18px rgba(109,61,242,.45);pointer-events:none}
`;
  document.head.appendChild(style);
}

const BANNER_ROTATE_MS = 3500;

function showBanner(banner) {
  const items = banner?.items;
  if (!banner || !banner.enabled || !Array.isArray(items) || !items.length) return;
  let dismissedId = null;
  try { dismissedId = sessionStorage.getItem("pr_banner_dismissed_id"); } catch { /* 무시 */ }
  if (dismissedId === banner.id) return;

  injectStyles();
  const el = document.createElement("div");
  el.className = `pr-banner pr-banner-${["small", "large"].includes(banner.size) ? banner.size : "medium"}`;

  const textEl = document.createElement("span");
  textEl.className = "pr-banner-text";
  textEl.textContent = items[0];
  el.appendChild(textEl);

  let timer = null;
  let dotsEl = null;
  if (items.length > 1) {
    dotsEl = document.createElement("div");
    dotsEl.className = "pr-banner-dots";
    dotsEl.innerHTML = items.map((_, i) => `<span class="${i === 0 ? "active" : ""}"></span>`).join("");
    el.appendChild(dotsEl);

    let index = 0;
    timer = setInterval(() => {
      index = (index + 1) % items.length;
      textEl.textContent = items[index];
      dotsEl.querySelectorAll("span").forEach((dot, i) => dot.classList.toggle("active", i === index));
    }, BANNER_ROTATE_MS);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "pr-banner-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    if (timer) clearInterval(timer);
    try { sessionStorage.setItem("pr_banner_dismissed_id", banner.id); } catch { /* 무시 */ }
    el.remove();
  });
  el.appendChild(closeBtn);
  document.body.prepend(el);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

// **굵게**만 지원하는 아주 단순한 마크다운. escapeHtml을 먼저 거치기 때문에
// <strong> 태그 외의 다른 HTML은 절대 끼어들 수 없습니다.
function renderBodyHtml(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// 실제 팝업과 관리 페이지의 미리보기가 똑같이 생기도록, 카드 DOM을 만드는
// 부분만 따로 떼어내 내보냅니다. onConfirm은 실제 팝업에서만 넘겨줍니다
// (미리보기에서는 버튼을 눌러도 아무 일도 일어나지 않아야 하므로).
export function buildAnnouncementCard(announcement, { onConfirm } = {}) {
  injectStyles();
  const card = document.createElement("div");
  card.className = "pr-modal-card";
  card.style.setProperty("--pr-accent", /^#[0-9a-fA-F]{3,8}$/.test(announcement.accentColor || "") ? announcement.accentColor : "#6d3df2");

  if (announcement.imageUrl) {
    const img = document.createElement("img");
    img.className = "pr-modal-image";
    img.src = announcement.imageUrl;
    img.alt = "";
    card.appendChild(img);
  }

  const h2 = document.createElement("h2");
  h2.textContent = announcement.title || "공지";
  const p = document.createElement("p");
  p.innerHTML = renderBodyHtml(announcement.body || "");
  const btn = document.createElement("button");
  btn.className = "pr-modal-btn";
  btn.type = "button";
  btn.textContent = "확인";
  btn.addEventListener("click", () => onConfirm && onConfirm());

  card.append(h2, p, btn);

  if (announcement.linkUrl) {
    const link = document.createElement("a");
    link.className = "pr-modal-link";
    link.href = announcement.linkUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = announcement.linkText || "자세히 보기";
    card.appendChild(link);
  }

  return card;
}

function showAnnouncement(announcement) {
  if (!announcement || !announcement.enabled || !announcement.id) return;
  let seenId = null;
  try { seenId = localStorage.getItem("pr_seen_announcement_id"); } catch { /* 무시 */ }
  if (seenId === announcement.id) return;

  const overlay = document.createElement("div");
  overlay.className = "pr-modal-overlay";
  const card = buildAnnouncementCard(announcement, {
    onConfirm: () => {
      try { localStorage.setItem("pr_seen_announcement_id", announcement.id); } catch { /* 무시 */ }
      overlay.remove();
    },
  });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// 로그인/회원가입 화면에서만 차단 여부를 확인하면, 이미 로그인해서 쓰고 있던
// 사람은 나중에 차단돼도 다시 로그인하기 전까지 계속 쓸 수 있습니다. 그래서
// 로그인한 모든 페이지에서 도는 이 스크립트에서도 같이 확인해서, 차단되면
// 바로 로그아웃시키고 로그인 화면으로 돌려보냅니다.
async function enforceBan(user, banned) {
  if (!banned) return false;
  try { await signOut(auth); } catch { /* 무시 */ }
  try { sessionStorage.setItem("pr_banned_notice", "1"); } catch { /* 무시 */ }
  window.location.replace("../login/");
  return true;
}

const BAN_RECHECK_MS = 5 * 60 * 1000;

// 어드민/매니저가 설정에서 켠 경우에만 보이는, 로그인한 모든 페이지 공통의
// 화면 테두리 그라데이션 효과. 홈 화면 하나가 아니라 어디서든(관리 페이지
// 포함) 지금 관리자 권한으로 보고 있다는 걸 알 수 있게 하는 용도입니다.
let adminGlowEl = null;
let adminChipEl = null;
function applyAdminGlow(active) {
  if (active) {
    injectStyles();
    if (!adminGlowEl) {
      adminGlowEl = document.createElement("div");
      adminGlowEl.className = "pr-admin-glow";
      document.body.appendChild(adminGlowEl);
    }
    if (!adminChipEl) {
      adminChipEl = document.createElement("div");
      adminChipEl.className = "pr-admin-chip";
      adminChipEl.textContent = "관리자 모드";
      document.body.appendChild(adminChipEl);
    }
  } else {
    adminGlowEl?.remove(); adminGlowEl = null;
    adminChipEl?.remove(); adminChipEl = null;
  }
}

async function loadNotices(user) {
  try {
    const idToken = await user.getIdToken();
    const res = await fetch(`${API_BASE}/api/notices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, uid: user.uid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (await enforceBan(user, data.banned)) return;
    showBanner(data.banner);
    showAnnouncement(data.announcement);
    applyAdminGlow(!!data.role && !!data.adminBackground);
  } catch {
    // 공지/차단 조회 실패는 화면 사용에 영향을 주지 않습니다.
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) loadNotices(user);
});

setInterval(() => {
  if (auth.currentUser) loadNotices(auth.currentUser);
}, BAN_RECHECK_MS);
