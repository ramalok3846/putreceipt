// 자연어 검색어를 날짜/금액/카테고리 조건 + 나머지 검색어로 분해합니다.
// 외부 AI 모델 없이 항상 동작하는 결정론적 규칙 기반 파서입니다(1차 필터).
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function startOfWeek(date) { const d = new Date(date); const day = (d.getDay() + 6) % 7; return addDays(d, -day); }

const CATEGORY_WORDS = ["식비", "카페", "교통", "생필품", "쇼핑", "의료", "기타"];

const DATE_RULES = [
  [/오늘/, () => { const t = new Date(); return { from: localDate(t), to: localDate(t) }; }],
  [/어제/, () => { const t = addDays(new Date(), -1); return { from: localDate(t), to: localDate(t) }; }],
  [/그제|그저께/, () => { const t = addDays(new Date(), -2); return { from: localDate(t), to: localDate(t) }; }],
  [/지난\s*주|저번\s*주/, () => { const start = addDays(startOfWeek(new Date()), -7); return { from: localDate(start), to: localDate(addDays(start, 6)) }; }],
  [/이번\s*주|금주/, () => { const start = startOfWeek(new Date()); return { from: localDate(start), to: localDate(new Date()) }; }],
  [/지난\s*달|저번\s*달/, () => { const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth() - 1, 1); const to = new Date(now.getFullYear(), now.getMonth(), 0); return { from: localDate(from), to: localDate(to) }; }],
  [/이번\s*달|이달/, () => { const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth(), 1); return { from: localDate(from), to: localDate(now) }; }],
  [/작년/, () => { const y = new Date().getFullYear() - 1; return { from: `${y}-01-01`, to: `${y}-12-31` }; }],
  [/올해/, () => { const now = new Date(); return { from: `${now.getFullYear()}-01-01`, to: localDate(now) }; }],
];

function koreanAmountToNumber(numText, unitText) {
  let n = Number(numText.replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  if (unitText === "만") n *= 10000;
  else if (unitText === "천") n *= 1000;
  return Math.round(n);
}

export function parseNaturalQuery(raw) {
  let text = String(raw || "").trim();
  const result = { dateFrom: "", dateTo: "", category: "all", minAmount: 0, maxAmount: Infinity, freeText: "" };

  for (const [re, fn] of DATE_RULES) {
    if (re.test(text)) { const { from, to } = fn(); result.dateFrom = from; result.dateTo = to; text = text.replace(re, " "); break; }
  }

  const nDaysAgo = text.match(/(\d+)\s*일\s*전/);
  if (nDaysAgo && !result.dateFrom) {
    const from = addDays(new Date(), -Number(nDaysAgo[1]));
    result.dateFrom = localDate(from); result.dateTo = localDate(new Date());
    text = text.replace(nDaysAgo[0], " ");
  }

  for (const cat of CATEGORY_WORDS) {
    if (text.includes(cat)) { result.category = cat; text = text.replace(cat, " "); break; }
  }

  const amountAbove = text.match(/(\d+(?:,\d{3})*)\s*(만|천)?\s*원?\s*(넘게|넘어서|넘어|초과|이상|넘)/);
  if (amountAbove) {
    const v = koreanAmountToNumber(amountAbove[1], amountAbove[2]);
    if (v != null) result.minAmount = v;
    text = text.replace(amountAbove[0], " ");
  }
  const amountBelow = text.match(/(\d+(?:,\d{3})*)\s*(만|천)?\s*원?\s*(이하|미만|안되는|안돼는|아래|안)/);
  if (amountBelow) {
    const v = koreanAmountToNumber(amountBelow[1], amountBelow[2]);
    if (v != null) result.maxAmount = v;
    text = text.replace(amountBelow[0], " ");
  }

  // 명확한 조사/문구는 부분 치환, 애매한 한 글자 잔여물(게/요/것 등)은 단어 단위로만 제거해
  // 가게명 속 글자("카페", "요기요" 등)를 잘못 지우지 않도록 합니다.
  text = text.replace(/에서요|에서|쓴\s*거|쓴\s*것|썼던|썼어|썼나|나왔|찾아줘|보여줘|알려줘|검색|영수증/g, " ");
  const noiseTokens = new Set(["게", "요", "것", "한", "건", "쓴", "를", "을", "에"]);
  text = text.split(/\s+/).filter(tok => tok && !noiseTokens.has(tok)).join(" ").trim();
  result.freeText = text;
  return result;
}
