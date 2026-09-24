// /preview 페이지의 승인/거부 버튼이 호출하는 함수입니다. 실제로 GitHub PR을 병합하거나
// 닫는, 권한이 필요한 동작이라 반드시 소유자 본인인지 확인한 뒤에만 실행합니다.
// GITHUB_TOKEN(저장소 쓰기 권한이 있는 GitHub 개인 액세스 토큰)과 OWNER_EMAIL(소유자
// Firebase 로그인 이메일)은 Netlify 환경변수에만 두고 코드에는 절대 넣지 않습니다.
const OWNER = "lagem1535-create";
const REPO = "putreceipt";
// firebase-config.js에도 이미 있는 공개 웹 API 키입니다(비밀 값이 아님). ID 토큰이 진짜
// 로그인된 사용자의 것인지 Firebase에게 직접 확인받는 데 씁니다.
const FIREBASE_WEB_API_KEY = "AIzaSyCEmf0KIiaF11nmS2CfBNA5yxZA9nrtmUU";

async function verifyOwnerEmail(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.users?.[0]?.email || null;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const githubToken = process.env.GITHUB_TOKEN;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!githubToken || !ownerEmail) {
    return jsonResponse(500, { error: "서버에 GITHUB_TOKEN 또는 OWNER_EMAIL이 설정되지 않았습니다. Netlify 환경변수를 확인해주세요." });
  }

  let payload;
  try { payload = await req.json(); } catch { return jsonResponse(400, { error: "잘못된 요청입니다." }); }
  const { idToken, prNumber, action } = payload;
  if (!idToken || !prNumber || !["approve", "reject"].includes(action)) {
    return jsonResponse(400, { error: "필요한 값이 없습니다." });
  }

  const email = await verifyOwnerEmail(idToken);
  if (!email || email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return jsonResponse(403, { error: "이 작업을 수행할 권한이 없습니다." });
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
      if (!res.ok) return jsonResponse(502, { error: data?.message || "병합에 실패했습니다." });
      return jsonResponse(200, { ok: true, merged: true });
    }

    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: ghHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    const data = await res.json();
    if (!res.ok) return jsonResponse(502, { error: data?.message || "PR 닫기에 실패했습니다." });
    return jsonResponse(200, { ok: true, closed: true });
  } catch {
    return jsonResponse(502, { error: "GitHub 호출에 실패했습니다." });
  }
};
