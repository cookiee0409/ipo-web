// IPO Lounge — app.js (v2 패치 적용)
'use strict';

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const TODAY = (()=>{
  const now = new Date();
  const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 9*60) * 60000);
  return new Date(kst.getFullYear(), kst.getMonth(), kst.getDate());
})();

// API 베이스 URL — 공개 홈페이지를 데이터 사이트와 분리 배포할 때 index.html에서 window.API_BASE 주입.
// 미설정(빈 문자열)이면 같은 출처(/api/*)를 사용 → 단일 도메인 배포에서도 그대로 동작.
const API_BASE = (typeof window!=='undefined' && window.API_BASE) ? String(window.API_BASE).replace(/\/$/,'') : '';

// ─────────────────────────────────────────────────────────────
// HTML ESCAPE (XSS 방지 — 외부 데이터를 innerHTML에 삽입할 때 사용)
// ─────────────────────────────────────────────────────────────
function escapeHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
const h=escapeHtml;

// ─────────────────────────────────────────────────────────────
// LOG ACTION
// ─────────────────────────────────────────────────────────────
async function logAction(action, detail) {
  try { fetch(API_BASE+'/api/log', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action, detail:String(detail||'')}) }); } catch(e) {}
}

// ─────────────────────────────────────────────────────────────
// IPOS_DATA — 기본 종목은 ipos-seed.js (window.IPOS_SEED)에서 불러옵니다.
// 두 파일(app.js / admin.html)이 같은 시드를 공유하기 위함입니다.
// ─────────────────────────────────────────────────────────────
const IPOS_DATA = (typeof window !== 'undefined' && window.IPOS_SEED) ? window.IPOS_SEED : [];

// ─────────────────────────────────────────────────────────────
// STORAGE / STATE
// ─────────────────────────────────────────────────────────────
const STORE_KEY = 'ipo_lounge_v3';
const DEL_KEY   = 'ipo_lounge_del';
const WL_KEY    = 'ipo_lounge_wl';
const HP_KEY    = 'ipo_history_prices';

let IPOS = [];
let globalHistoryPrices = {};
// prices_latest (cron-price가 매일 21시 KST에 저장하는 "실제 현재가" 소스)
// 모든 화면이 이 값을 1순위로 써서 현재가가 화면마다 다른 문제를 방지한다.
let globalLatestPrices = {};

// 종목의 "현재가"를 단일 기준으로 반환.
// 1순위: prices_latest.currentPrice (공공데이터 전일 종가, 매일 21시 갱신 · KIS 미사용)
// 2순위: history_prices의 가장 최근 종가(dNClose) — 상장 직후 prices_latest가 아직 없을 때
function getCurrentPrice(ipo){
  if(!ipo) return null;
  const code=ipo.code;
  const lp=globalLatestPrices[code];
  if(lp && lp.currentPrice!=null && lp.currentPrice>0) return lp.currentPrice;
  const db=globalHistoryPrices[code]||{};
  for(let n=7;n>=0;n--){ if(db[`d${n}Close`]!=null&&db[`d${n}Close`]>0) return db[`d${n}Close`]; }
  return null;
}
// 현재가 갱신 시각 라벨 (있으면)
function currentPriceAsOf(ipo){
  const lp=ipo&&globalLatestPrices[ipo.code];
  return (lp&&lp.asOf)?lp.asOf:null;
}
// 현재가 옆 물음표 주석 (호버 시 설명 + 마지막 갱신 시각)
function priceInfoTip(ipo){
  const asOf=currentPriceAsOf(ipo);
  let when='갱신 시각 정보 없음';
  if(asOf){
    const d=new Date(asOf);
    when='마지막 갱신: '+d.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  const msg='이 현재가는 실시간 시세가 아니라 매일 하루 한 번(영업일 장 마감 후) 갱신되는 값입니다. '+when;
  return `<span class="price-tip" tabindex="0" aria-label="${msg}"><span class="price-tip-q">?</span><span class="price-tip-box">${msg}</span></span>`;
}
let watchlist = [];
let isAdmin = false;

function el(id)  { return document.getElementById(id); }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel){ return document.querySelectorAll(sel); }

function notify(msg, type=''){
  const t = el('toast');
  t.className = 'show' + (type?' '+type:'');
  t.textContent = msg;
  setTimeout(()=>t.className='', 2800);
}

// ─────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────
function loadAll(){
  try{ watchlist = JSON.parse(localStorage.getItem(WL_KEY)||'[]'); }catch(e){ watchlist=[]; }
  try{ globalHistoryPrices = JSON.parse(localStorage.getItem(HP_KEY)||'{}'); }catch(e){ globalHistoryPrices={}; }
  // 초기엔 비워두고, DB(/api/ipos)를 단일 소스로 사용한다.
  // DB가 완전히 비어있을 때만(최초·미시드 상태) 시드를 폴백으로 표시한다.
  IPOS = [];
  loadFromDB();
  isAdmin = new URLSearchParams(location.search).has('admin');
  if(isAdmin){ el('admin-bar').classList.add('show'); el('main-nav').classList.add('has-admin'); }
}

async function loadFromDB(){
  try{
    const [dbIpos, dbComp, dbHP] = await Promise.all([
      fetch(API_BASE+'/api/ipos').then(r=>r.ok?r.json():[]).catch(()=>[]),
      fetch(API_BASE+'/api/comp').then(r=>r.ok?r.json():{}).catch(()=>({})),
      fetch(API_BASE+'/api/cron-update').then(r=>r.ok?r.json():{}).catch(()=>({})),
    ]);
    if(Array.isArray(dbIpos)&&dbIpos.length){
      // DB가 단일 소스: DB에 있는 종목만 사용 (admin에서 지운 건 진짜로 사라짐)
      IPOS = dbIpos.map(db=>({...db}));
    } else {
      // DB가 비어있으면(최초·미시드) 시드를 폴백으로 표시
      IPOS = (window.IPOS_SEED ? window.IPOS_SEED.map(s=>({...s})) : []);
    }
    if(dbComp&&typeof dbComp==='object'){
      Object.entries(dbComp).forEach(([id,rate])=>{ const ipo=IPOS.find(i=>String(i.id)===String(id)); if(ipo&&!ipo.competitionRate) ipo.competitionRate=rate; });
    }
    if(dbHP&&typeof dbHP==='object'){ Object.assign(globalHistoryPrices, dbHP); localStorage.setItem(HP_KEY, JSON.stringify(globalHistoryPrices)); }
    dedupeIpos();
    renderCurrentTab();
    loadLatestPrices(); // prices_latest 현재가 일괄 로드 (비동기, 끝나면 재렌더)
  }catch(e){}
}

// 상장된 전 종목의 현재가(prices_latest)를 한 번에 가져와 globalLatestPrices에 채운다.
async function loadLatestPrices(){
  try{
    const codes=[...new Set(IPOS.filter(i=>i.code&&/^[A-Za-z0-9]{6}$/.test(i.code)).map(i=>i.code))];
    if(!codes.length) return;
    const res=await fetch(API_BASE+'/api/price?codes='+codes.join(','));
    if(!res.ok) return;
    const data=await res.json();
    const asOf=data.updatedAt||null;
    (data.items||[]).forEach(x=>{ if(x&&x.code) globalLatestPrices[String(x.code)]={ currentPrice:x.currentPrice, changeRate:x.changeRate, asOf }; });
    // 현재가가 반영되도록 현재 탭 다시 렌더
    renderCurrentTab();
  }catch(e){}
}

// 중복 종목 제거: 종목명+청약시작일이 같으면 하나만 유지 (데이터가 더 많은 쪽 우선)
function dedupeIpos(){
  const seen={};
  const score=i=>(i.competitionRate?2:0)+(i.finalPrice?1:0)+((i.securities||[]).length?1:0);
  IPOS.forEach(i=>{
    const key=`${i.name}|${i.subscribeStart||''}`;
    if(!seen[key]||score(i)>score(seen[key])) seen[key]=i;
  });
  IPOS=Object.values(seen);
}

function saveAll(){
  // 종목은 DB(/api/ipos)가 단일 소스이므로 localStorage에 저장하지 않는다.
  // 관심목록만 로컬에 보관한다.
  localStorage.setItem(WL_KEY, JSON.stringify(watchlist));
  // 과거 버전이 남긴 종목 캐시 정리 (한 번 실행되면 그만)
  try{ localStorage.removeItem(STORE_KEY); localStorage.removeItem(DEL_KEY); }catch(e){}
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const fmt = {
  won:  v => v==null?'—':Number(v).toLocaleString('ko-KR')+'원',
  num:  v => v==null?'—':Number(v).toLocaleString('ko-KR'),
  rate: v => v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%',
};
function fmtPct(v){ return v==null || v==='' ? '—' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '%'; }
function fmtShares(v){ return v==null || v==='' ? '—' : Number(v).toLocaleString('ko-KR') + '주'; }
function safeHtml(v){ return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function safeUrl(v){ const s=String(v||'').trim(); return /^https:\/\/dart\.fss\.or\.kr\//.test(s) ? s : ''; }
function hasAny(ipo, keys){ return keys.some(k => ipo[k] != null && ipo[k] !== ''); }
function infoRow(label, value){ return `<tr><td>${label}</td><td style="text-align:right;font-weight:600">${value}</td></tr>`; }
function calcReturn(base, price){ if(!base||!price) return null; return (price-base)/base*100; }
function calcStatus(ipo){
  const t=new Date(TODAY.getFullYear(),TODAY.getMonth(),TODAY.getDate());
  const toD=s=>{ if(!s) return null; const[y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
  const lst=toD(ipo.listingDate); const ss=toD(ipo.subscribeStart); const se=toD(ipo.subscribeEnd)||ss;
  if(lst&&lst<=t) return 'listed';
  if(se&&se<t) return 'past';
  if(ss&&ss<=t&&(!se||se>=t)) return 'active';
  return 'upcoming';
}
// 청약 마감 후 상장 전이면 'prelisting'(상장예정), 그 외는 calcStatus 그대로
function calcStatusDetail(ipo){
  const s=calcStatus(ipo);
  if(s==='past'){
    const t=new Date(TODAY.getFullYear(),TODAY.getMonth(),TODAY.getDate());
    const toD=x=>{ if(!x) return null; const[y,m,d]=x.split('-').map(Number); return new Date(y,m-1,d); };
    const lst=toD(ipo.listingDate);
    // 상장일이 미래이거나(아직 상장 전), 상장일이 미정이면 상장예정으로 간주
    if(!lst || lst>t) return 'prelisting';
  }
  return s;
}
function statusBadge(s){
  const m={active:['badge-active','청약중'],upcoming:['badge-upcoming','청약예정'],listed:['badge-listed','상장완료'],past:['badge-past','지난청약'],prelisting:['badge-upcoming','상장예정']};
  const[c,l]=m[s]||['badge-past','—'];
  return `<span class="badge ${c}">${l}</span>`;
}
function fmtDate(s){ return s?s.slice(5).replace('-','/'):'미정'; }
// 의무보유확약 해제 예정일: admin에서 입력했거나(lockupDate) 신고서에서 추출된 경우에만 반환.
// 알 수 없으면 null → 표시/캘린더 등록하지 않음 (임의 추정하지 않음)
function lockupReleaseDate(ipo){
  return ipo.escrowReleaseDate || ipo.lockupDate || null;
}
// 이전(상장완료) 종목은 최근 N개월 이내만 취급
function isWithinMonths(dateStr, months){
  if(!dateStr) return false;
  const d=new Date(dateStr+'T00:00:00'); if(isNaN(d)) return false;
  const cutoff=new Date(TODAY.getFullYear(), TODAY.getMonth()-months, TODAY.getDate());
  return d>=cutoff;
}

// ── 공모주 종합 등급 (S~D) ──────────────────────────────────────────────
// 3개 핵심 지표를 0~100점으로 가중 합산해 등급을 부여한다.
//   ① 기관 수요예측 경쟁률 (가중 40) — 높을수록 ↑
//   ② 의무보유확약 비율 %     (가중 35) — 높을수록 ↑ (조기 매도물량 ↓)
//   ③ 상장 직후 유통가능 비율 %(가중 25) — 낮을수록 ↑ (오버행 부담 ↓)
// 없는 지표는 제외하고 가용 가중치로 정규화한다. 경쟁률(핵심 선행지표)이
// 없으면 '수요예측 전'으로 등급 미정 처리한다(임의 추정하지 않음).
function ipoGrade(ipo){
  if(!ipo) return null;
  const comp = ipo.competitionRate ?? ipo.institutionalCompetitionRate;
  const lock = ipo.lockup ?? ipo.lockupTotalRatio;
  const floatPct = ipo.tradableRatioAfterListing;
  if(comp == null || !(comp > 0))
    return { grade:null, score:null, provisional:true, parts:[], label:'수요예측 전', desc:'' };

  const parts = []; // {key, weight, pts(0~1), val}
  const compPts = comp>=1000?1 : comp>=700?0.85 : comp>=400?0.65 : comp>=200?0.4 : comp>=100?0.2 : 0.05;
  parts.push({ key:'기관경쟁률', weight:40, pts:compPts, val:fmt.num(comp)+':1' });
  if(lock != null){
    const lockPts = lock>=30?1 : lock>=20?0.8 : lock>=15?0.62 : lock>=10?0.4 : lock>=5?0.2 : 0.05;
    parts.push({ key:'의무확약', weight:35, pts:lockPts, val:lock+'%' });
  }
  if(floatPct != null){
    const fPts = floatPct<=20?1 : floatPct<=30?0.8 : floatPct<=40?0.55 : floatPct<=50?0.3 : 0.05;
    parts.push({ key:'유통물량', weight:25, pts:fPts, val:floatPct+'%' });
  }
  const totW = parts.reduce((s,p)=>s+p.weight,0);
  const score = Math.round(parts.reduce((s,p)=>s+p.pts*p.weight,0)/totW*100);
  const grade = score>=80?'S' : score>=65?'A' : score>=45?'B' : score>=25?'C' : 'D';
  const provisional = !(lock!=null && floatPct!=null);
  return { grade, score, provisional, parts, label:grade+(provisional?' (잠정)':''), desc:gradeDesc(grade) };
}
function gradeDesc(g){
  return ({ S:'매우 우수 — 기관 수요·확약 강함, 오버행 부담 낮음',
            A:'우수 — 전반적으로 양호',
            B:'보통 — 일부 지표 평이',
            C:'주의 — 수요/확약이 약하거나 유통물량 부담',
            D:'위험 — 수요 저조 또는 오버행 부담 큼' })[g] || '';
}
function gradeColor(g){
  return ({ S:'var(--gold)', A:'var(--positive)', B:'var(--teal)', C:'#E08A1E', D:'var(--negative)' })[g] || 'var(--text3)';
}
function ratingScore(ipo){
  const g=ipoGrade(ipo);
  if(g&&g.score!=null) return g.score;
  const r=riskProfile(ipo);
  if(r.score!=null) return Math.max(0,100-r.score);
  return 50;
}
function starCount(ipo){
  const score=ratingScore(ipo);
  return Math.max(1,Math.min(5,Math.round(score/20)));
}
function starRating(ipo){
  const n=starCount(ipo);
  return `<span class="star-rating" title="추천도 ${n}/5">${[1,2,3,4,5].map(i=>`<span class="${i<=n?'on':''}">★</span>`).join('')}</span>`;
}
// 목록용 소형 등급 칩 (등급 미정이면 빈 문자열)
function gradeChip(ipo){
  const g = ipoGrade(ipo);
  if(!g || g.grade == null) return '';
  return `<span title="종합등급 ${g.label}" style="display:inline-block;min-width:17px;text-align:center;font-size:11px;font-weight:800;color:#fff;background:${gradeColor(g.grade)};border-radius:5px;padding:1px 5px;margin-left:6px;vertical-align:middle">${g.grade}</span>`;
}
function riskProfile(ipo){
  if(!ipo) return { level:'unknown', score:null, label:'데이터 대기', badges:[{type:'muted', text:'데이터 대기'}], notes:['수요예측 결과와 유통물량 데이터가 더 필요합니다.'] };
  const badges=[];
  const notes=[];
  let score=0;
  const numOrNull=v=>(v==null||v==='')?null:Number(v);
  const comp=numOrNull(ipo.competitionRate ?? ipo.institutionalCompetitionRate);
  const lock=numOrNull(ipo.lockup ?? ipo.lockupTotalRatio);
  const floatPct=numOrNull(ipo.tradableRatioAfterListing);
  const topRatio=numOrNull(ipo.priceTopOrAboveRatio);
  const priceTop=ipo.priceRange&&ipo.priceRange.length?Number(ipo.priceRange[1]):0;
  const finalPrice=Number(ipo.finalPrice)||0;

  if(comp>0){
    if(comp<300){ score+=30; badges.push({type:'high', text:'수요 약함'}); notes.push('기관 경쟁률이 낮아 상장 초반 수급 부담이 있을 수 있습니다.'); }
    else if(comp<800){ score+=16; badges.push({type:'mid', text:'수요 보통'}); }
    else { score-=8; badges.push({type:'low', text:'수요 양호'}); }
  } else {
    score+=12; badges.push({type:'muted', text:'수요예측 전'}); notes.push('기관 경쟁률 미공시 상태라 리스크를 보수적으로 봅니다.');
  }

  if(lock!=null && Number.isFinite(lock)){
    if(lock<5){ score+=24; badges.push({type:'high', text:'확약 낮음'}); notes.push('의무보유확약 비율이 낮으면 단기 매도 물량 부담이 커질 수 있습니다.'); }
    else if(lock<15){ score+=12; badges.push({type:'mid', text:'확약 보통'}); }
    else { score-=6; badges.push({type:'low', text:'확약 양호'}); }
  }

  if(floatPct!=null && Number.isFinite(floatPct) && floatPct>0){
    if(floatPct>45){ score+=24; badges.push({type:'high', text:'유통물량 많음'}); notes.push('상장 직후 유통가능 물량 비율이 높습니다.'); }
    else if(floatPct>30){ score+=12; badges.push({type:'mid', text:'유통 보통'}); }
    else { score-=6; badges.push({type:'low', text:'유통 부담 낮음'}); }
  }

  if(finalPrice&&priceTop&&finalPrice>=priceTop){
    if(topRatio>0&&topRatio<60){ score+=8; badges.push({type:'mid', text:'가격 상단 주의'}); }
    else badges.push({type:'info', text:'상단 확정'});
  }

  score=Math.max(0,Math.min(100,score));
  const level=score>=55?'high':score>=30?'mid':score>=15?'low':'safe';
  const label={high:'주의',mid:'보통',low:'낮음',safe:'낮음',unknown:'데이터 대기'}[level];
  if(!badges.length) badges.push({type:'muted', text:'리스크 미정'});
  return { level, score, label, badges:badges.slice(0,4), notes };
}
function riskBadgeGroup(ipo, compact){
  const r=riskProfile(ipo);
  const lead=`<span class="risk-badge risk-${r.level}">${compact?'리스크 ':''}${r.label}</span>`;
  const bits=(compact?[]:r.badges).map(b=>`<span class="risk-badge risk-${b.type}">${h(b.text)}</span>`);
  return `<span class="risk-badges">${lead}${bits.join('')}</span>`;
}
function riskPanel(ipo){
  const r=riskProfile(ipo);
  const notes=r.notes.length?r.notes:['현재 공개 지표 기준으로 특별히 큰 위험 신호는 보이지 않습니다.'];
  return `<div class="panel risk-panel" style="margin-top:13px">
    <div class="panel-head"><h2>리스크 배지</h2>${riskBadgeGroup(ipo,false)}</div>
    <div class="risk-panel-body">
      ${notes.slice(0,3).map(n=>`<div class="risk-note">${h(n)}</div>`).join('')}
      <div class="risk-foot">기관 경쟁률, 의무보유확약, 상장 직후 유통가능 물량을 중심으로 단기 변동 위험을 요약합니다.</div>
    </div>
  </div>`;
}
function renderCompareTable(items, activeId, bare){
  const list=(items&&items.length?items:_plannerPool()).slice()
    .sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'));
  if(!list.length) return '';
  const table=`<div class="compare-table-wrap">
      <table class="compare-table">
        <thead><tr><th>종목</th><th>공모가</th><th>최소 증거금</th><th>수요예측</th><th>확약</th><th>유통</th><th>리스크</th><th>청약일</th></tr></thead>
        <tbody>${list.map(i=>`
          <tr class="${String(activeId)===String(i.id)?'is-active':''}" onclick="stratPickIpo('${h(i.id)}')">
            <td><strong>${h(i.name)}</strong><span>${h(i.sector||'섹터미정')}${gradeChip(i)}</span></td>
            <td>${fmtPriceBand(i)}</td>
            <td>${_minDeposit(i)?_minDeposit(i).toLocaleString('ko-KR')+'원':'—'}</td>
            <td>${i.competitionRate?fmt.num(i.competitionRate)+':1':'미정'}</td>
            <td>${fmtPct(i.lockup ?? i.lockupTotalRatio)}</td>
            <td>${fmtPct(i.tradableRatioAfterListing)}</td>
            <td>${riskBadgeGroup(i,true)}</td>
            <td>${fmtDate(i.subscribeStart)}${i.subscribeEnd&&i.subscribeEnd!==i.subscribeStart?'~'+fmtDate(i.subscribeEnd):''}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  if(bare) return table;
  return `<div class="panel compare-panel" style="margin-top:14px">
    <div class="panel-head"><h2>종목 비교표</h2><span class="compare-count">${list.length}개 종목</span></div>
    ${table}
  </div>`;
}
function gradeSummaryChip(ipo){
  const g=ipoGrade(ipo);
  if(!g || !g.grade) return '<span class="grade-mini muted">등급 대기</span>';
  return `<span class="grade-mini" style="--grade-color:${gradeColor(g.grade)}"><b>${g.grade}</b>${g.score}점${g.provisional?' · 잠정':''}</span>`;
}
function strategyRiskSummary(ipo){
  const r=riskProfile(ipo);
  return `<div class="strat-risk-summary">
    <div class="srs-head">${riskBadgeGroup(ipo,false)}</div>
    <div class="srs-copy">${h((r.notes&&r.notes[0]) || '현재 공개 지표 기준으로 특별히 큰 위험 신호는 보이지 않습니다.')}</div>
  </div>`;
}
function strategyGradeSummary(ipo){
  const g=ipoGrade(ipo);
  if(!g || !g.grade) return `<div class="strat-grade-summary muted">수요예측 완료 후 종합 등급이 산정됩니다.</div>`;
  const bars=g.parts.slice(0,3).map(p=>`<div class="sg-row"><span>${h(p.key)}</span><b>${h(p.val)}</b><i><em style="width:${Math.round(p.pts*100)}%;background:${gradeColor(g.grade)}"></em></i></div>`).join('');
  return `<div class="strat-grade-summary">
    <div class="sg-top">${gradeSummaryChip(ipo)}<span>${h(g.desc)}</span></div>
    <div class="sg-bars">${bars}</div>
  </div>`;
}
function renderMiniCompareTable(items, activeId){
  const list=(items||[]).slice().sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'));
  if(!list.length) return '';
  return `<div class="mini-compare">
    <div class="mini-compare-head"><span>종목</span><span>공모가</span><span>청약일</span><span>리스크</span></div>
    ${list.map(i=>`<button class="mini-compare-row ${String(activeId)===String(i.id)?'on':''}" onclick="stratPickIpo('${h(i.id)}')">
      <span><b>${h(i.name)}</b><em>${h(i.sector||'섹터미정')}</em></span>
      <span>${fmtPriceBand(i)}</span>
      <span>${fmtDate(i.subscribeStart)}</span>
      <span>${riskBadgeGroup(i,true)}</span>
    </button>`).join('')}
  </div>`;
}
// 등급 + 지표별 기여도 막대 패널 (자기완결적 인라인 스타일)
function gradePanel(ipo){
  const g = ipoGrade(ipo);
  if(!g) return '';
  if(g.grade == null){
    return `<div class="panel" style="padding:16px;margin-bottom:13px;display:flex;align-items:center;gap:14px">
      <div style="width:54px;height:54px;flex-shrink:0;border:2px dashed var(--border);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:var(--text3)">–</div>
      <div><div style="font-weight:700;font-size:15px">종합 등급 미정</div>
      <div style="font-size:12px;color:var(--text3);margin-top:2px">수요예측 완료 후 기관경쟁률·의무확약·유통물량으로 자동 산정됩니다.</div></div>
    </div>`;
  }
  const c = gradeColor(g.grade);
  const bars = g.parts.map(p=>`
    <div style="display:flex;align-items:center;gap:8px;margin-top:7px">
      <span style="width:64px;font-size:12px;color:var(--text2);flex-shrink:0">${p.key}</span>
      <span style="width:58px;font-size:12px;font-weight:700;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums">${p.val}</span>
      <span style="flex:1;height:7px;background:var(--bg2);border-radius:5px;overflow:hidden"><span style="display:block;height:100%;width:${Math.round(p.pts*100)}%;background:${c};border-radius:5px"></span></span>
    </div>`).join('');
  const provBadge = g.provisional?' <span style="font-size:10px;font-weight:700;color:#fff;background:var(--text3);padding:1px 6px;border-radius:6px;vertical-align:middle">잠정</span>':'';
  return `<div class="panel" style="padding:16px;margin-bottom:13px">
    <div style="display:flex;align-items:center;gap:14px">
      <div style="width:54px;height:54px;flex-shrink:0;border:2px solid ${c};color:${c};border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;line-height:1">${g.grade}</div>
      <div style="min-width:0">
        <div style="font-weight:800;font-size:15px">종합 등급 ${g.grade} · ${g.score}점${provBadge}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px">${g.desc}</div>
      </div>
    </div>
    <div style="margin-top:12px">${bars}</div>
    <div style="font-size:10.5px;color:var(--text3);margin-top:11px;line-height:1.5">※ 기관 수요예측 경쟁률(40)·의무보유확약(35)·상장 직후 유통가능 비율(25) 가중 합산. 투자판단 참고용이며 수익을 보장하지 않습니다.${g.provisional?' 일부 지표 미공시로 잠정 산정되었습니다.':''}</div>
  </div>`;
}

function reviewInfoPanels(ipo){
  const panels=[];
  if(hasAny(ipo, ['competitionRate','institutionalCompetitionRate','participantCount','priceTopOrAboveRatio','finalPrice'])){
    panels.push(`<div class="panel" style="margin-top:13px">
      <div class="panel-head"><h2>수요예측 결과</h2></div>
      <table class="data-table"><tbody>
        ${infoRow('기관 경쟁률', ipo.competitionRate || ipo.institutionalCompetitionRate ? fmt.num(ipo.competitionRate || ipo.institutionalCompetitionRate)+':1' : '—')}
        ${infoRow('참여기관 수', ipo.participantCount ? fmt.num(ipo.participantCount)+'곳' : '—')}
        ${infoRow('희망공모가', fmtPriceBand({ priceRange: ipo.priceRange || [], finalPrice: null }))}
        ${infoRow('확정공모가', ipo.finalPrice ? fmt.won(ipo.finalPrice) : '—')}
        ${infoRow('상단 이상 신청 비율', fmtPct(ipo.priceTopOrAboveRatio))}
      </tbody></table>
    </div>`);
  }
  if(hasAny(ipo, ['lockup','lockupTotalRatio','lockup15DaysRatio','lockup1MonthRatio','lockup3MonthsRatio','lockup6MonthsRatio','lockupUncommittedRatio'])){
    panels.push(`<div class="panel" style="margin-top:13px">
      <div class="panel-head"><h2>의무보유확약</h2></div>
      <table class="data-table"><tbody>
        ${infoRow('총 확약 비율', fmtPct(ipo.lockup ?? ipo.lockupTotalRatio))}
        ${infoRow('15일', fmtPct(ipo.lockup15DaysRatio))}
        ${infoRow('1개월', fmtPct(ipo.lockup1MonthRatio))}
        ${infoRow('3개월', fmtPct(ipo.lockup3MonthsRatio))}
        ${infoRow('6개월', fmtPct(ipo.lockup6MonthsRatio))}
        ${infoRow('미확약', fmtPct(ipo.lockupUncommittedRatio))}
      </tbody></table>
    </div>`);
  }
  if(hasAny(ipo, ['listedSharesTotal','totalShares','tradableSharesAfterListing','tradableRatioAfterListing'])){
    panels.push(`<div class="panel" style="margin-top:13px">
      <div class="panel-head"><h2>상장 후 유통가능물량</h2></div>
      <table class="data-table"><tbody>
        ${infoRow('상장예정주식수', fmtShares(ipo.listedSharesTotal || ipo.totalShares))}
        ${infoRow('상장 직후 유통가능 주식수', fmtShares(ipo.tradableSharesAfterListing))}
        ${infoRow('상장 직후 유통가능 비율', fmtPct(ipo.tradableRatioAfterListing))}
      </tbody></table>
    </div>`);
  }
  if(hasAny(ipo, ['escrowReleaseDate','escrowReleaseShares','escrowReleaseRatio'])){
    panels.push(`<div class="panel" style="margin-top:13px">
      <div class="panel-head"><h2>보호예수 해제 일정</h2></div>
      <table class="data-table"><tbody>
        ${infoRow('보호예수 해제일', ipo.escrowReleaseDate || ipo.lockupDate || '—')}
        ${infoRow('해제 주식수', fmtShares(ipo.escrowReleaseShares))}
        ${infoRow('해제 비율', fmtPct(ipo.escrowReleaseRatio))}
      </tbody></table>
    </div>`);
  }
  if(hasAny(ipo, ['sourceReportName','dartRceptNo','rceptNo','dartUrl'])){
    const url=safeUrl(ipo.dartUrl || (ipo.dartRceptNo || ipo.rceptNo ? 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + encodeURIComponent(ipo.dartRceptNo || ipo.rceptNo) : ''));
    const sourceLink = url ? `<a class="panel-more" href="${url}" target="_blank" rel="noopener">공시 열기 →</a>` : '';
    panels.push(`<div class="panel" style="margin-top:13px">
      <div class="panel-head"><h2>DART 출처</h2>${sourceLink}</div>
      <table class="data-table"><tbody>
        ${infoRow('출처 공시명', safeHtml(ipo.sourceReportName || '—'))}
        ${infoRow('DART 접수번호', safeHtml(ipo.dartRceptNo || ipo.rceptNo || '—'))}
      </tbody></table>
    </div>`);
  }
  return panels.join('');
}
function fmtPriceBand(ipo){
  if(ipo.finalPrice) return fmt.won(ipo.finalPrice);
  if(ipo.priceRange && ipo.priceRange[0]){ const[l,h]=ipo.priceRange; return l===h?fmt.won(l):`<span style="white-space:nowrap">${fmt.num(l)}~${fmt.num(h)}원</span>`; }
  return '미정';
}
function buildEvents(ipos){
  const map={};
  function push(d,type,ipo){ if(!d)return; (map[d]=map[d]||[]).push({type,ipo}); }
  ipos.forEach(i=>{ push(i.subscribeStart,'sub',i); if(i.subscribeEnd&&i.subscribeEnd!==i.subscribeStart) push(i.subscribeEnd,'sub',i); push(i.refundDate,'ref',i); push(i.listingDate,'lst',i); const lr=lockupReleaseDate(i); if(lr) push(lr,'lock',i); });
  return map;
}

// ─────────────────────────────────────────────────────────────
// IPO CARD
// ─────────────────────────────────────────────────────────────
function ipoCard(ipo){
  const s=calcStatus(ipo);
  const sec=ipo.securities&&ipo.securities.length>0?ipo.securities.join(', '):'미정';
  const market=ipo.market||'KOSDAQ';
  let dBadgeText='', dBadgeClass=s;
  if(s==='active'){ const end=ipo.subscribeEnd?new Date(ipo.subscribeEnd+'T00:00:00'):null; if(end){ const diff=Math.ceil((end-TODAY)/86400000); dBadgeText=diff===0?'● D-Day':diff>0?`● D-${diff}`:'● 마감'; } else dBadgeText='● 청약중'; }
  else if(s==='upcoming'){ const start=ipo.subscribeStart?new Date(ipo.subscribeStart+'T00:00:00'):null; if(start){ const diff=Math.ceil((start-TODAY)/86400000); dBadgeText=diff>0?`D-${diff}`:'곧 시작'; } else dBadgeText='예정'; }
  else if(s==='listed'){ dBadgeText='상장완료'; }
  else { dBadgeText='청약완료'; }
  // 경쟁률 미정 시 회색 바 + "미정" 표기 (카드 레이아웃 고정)
  const hasComp=ipo.competitionRate!=null && ipo.competitionRate>0;
  const compRatio=hasComp?Math.min((ipo.competitionRate/3000)*100,100):100;
  return `<div class="ipo-card" onclick="openModal('${h(ipo.id)}')">
    <div class="ipo-card-top">
      <div style="flex:1;min-width:0">
        <div class="ipo-card-name">${h(ipo.name)}</div>
        <div class="ipo-card-market" style="margin-top:5px"><span class="ipo-card-market-tag">${h(market)}</span><span class="ipo-card-sector-tag">${h(ipo.sector||'')}</span></div>
        <div style="margin-top:8px">${riskBadgeGroup(ipo,true)}</div>
      </div>
      <div class="ipo-card-right"><div class="d-badge ${dBadgeClass}">${dBadgeText}</div></div>
    </div>
    <div class="ipo-card-divider"></div>
    <div class="ipo-card-stats">
      <div class="ipo-stat-item"><div class="l">공모가</div><div class="v accent">${fmtPriceBand(ipo)}</div></div>
      <div class="ipo-stat-item"><div class="l">수요예측 경쟁률</div><div class="v">${hasComp?fmt.num(ipo.competitionRate)+':1':'미정'}</div></div>
      <div class="ipo-stat-item"><div class="l">청약일</div><div class="v">${fmtDate(ipo.subscribeStart)}${ipo.subscribeEnd&&ipo.subscribeEnd!==ipo.subscribeStart?'~'+fmtDate(ipo.subscribeEnd):''}</div></div>
      <div class="ipo-stat-item"><div class="l">상장일</div><div class="v">${fmtDate(ipo.listingDate)}</div></div>
    </div>
    <div class="ipo-card-comp-bar"><div class="comp-bar-label"><span>경쟁률</span><span>${hasComp?fmt.num(ipo.competitionRate)+':1':'미정'}</span></div><div class="comp-bar-track"><div class="comp-bar-fill ${hasComp?'':'undetermined'}" style="width:${compRatio}%"></div></div></div>
    <div class="ipo-card-foot"><span class="ipo-card-sec">🏛 ${h(sec)}</span><span class="ipo-card-more">상세 보기 →</span></div>
  </div>`;
}

function ipoListRow(ipo){
  const sd=calcStatusDetail(ipo);
  const sec=ipo.securities&&ipo.securities.length>0?ipo.securities[0]+(ipo.securities.length>1?`...`:''):'—';
  // 마지막 열: 지난청약/상장 관련이면 상장일, 아니면 환불일
  // 상장일: 상장완료/상장예정이면 표시, 미정이면 '미정'
  let listingCell;
  if(sd==='listed'||sd==='prelisting'){
    listingCell=ipo.listingDate?fmtDate(ipo.listingDate):'미정';
  } else {
    listingCell=fmtDate(ipo.refundDate);
  }
  const lastColLabel=(sd==='listed'||sd==='prelisting')?'상장일':'환불일';
  return `<div class="ipo-list-row" onclick="openModal('${h(ipo.id)}')">
    <div><span class="badge" style="font-size:12px;padding:3px 8px;background:var(--border-soft);color:var(--text2)">${h(ipo.sector||'—')}</span></div>
    <div><div style="font-weight:700;font-size:15px">${h(ipo.name)}</div>${ipo.code?`<div style="font-size:12px;color:var(--text3);margin-top:1px">${h(ipo.code)}</div>`:''}<div style="margin-top:6px">${statusBadge(sd)}</div><div style="margin-top:5px">${riskBadgeGroup(ipo,true)}</div></div>
    <div style="font-variant-numeric:tabular-nums;color:var(--text2);font-size:14px">${fmtPriceBand(ipo)}</div>
    <div style="font-size:14px">${fmtDate(ipo.subscribeStart)}${ipo.subscribeEnd&&ipo.subscribeEnd!==ipo.subscribeStart?'~'+fmtDate(ipo.subscribeEnd):''}</div>
    <div style="font-size:14px" data-collabel="${lastColLabel}">${listingCell}</div>
    <div style="font-weight:700;font-variant-numeric:tabular-nums;font-size:14px">${ipo.competitionRate?fmt.num(ipo.competitionRate)+':1':'—'}</div>
    <div style="font-size:13px;color:var(--text2)">${h(sec)}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────────
function openModal(id){
  const ipo=IPOS.find(i=>String(i.id)===String(id));
  if(!ipo) return;
  const s=calcStatus(ipo);
  const secStr=(ipo.securities&&ipo.securities.length)?(ipo.securities.join(', ')):'주관사 미정';
  el('modal-name').textContent=ipo.name;
  el('modal-sub').textContent=`${ipo.sector||''}${secStr?' · '+secStr:''}`;
  const db=globalHistoryPrices[ipo.code]||{};
  let perfHTML='';
  if(s==='listed'&&ipo.finalPrice&&(db.d0High||db.weekHigh)){
    const d0h=db.d0High??null; const wHigh=db.weekHigh??d0h; const wDay=db.weekHighDay;
    const dayLbl=wDay!=null?['D+0','D+1','D+2','D+3','D+4','D+5','D+6','D+7'][wDay]:'D+?';
    const d0Ret=calcReturn(ipo.finalPrice,d0h); const wRet=calcReturn(ipo.finalPrice,wHigh);
    perfHTML=`<div style="background:var(--positive-tint);border:1px solid rgba(74,139,111,.2);border-radius:10px;padding:14px 16px;margin-bottom:14px">
      <div style="font-weight:600;font-size:13px;color:var(--positive);margin-bottom:8px">📊 상장 성과</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div><div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">D+0 최고가</div><div style="font-weight:600">${fmt.won(d0h)}</div><div style="font-size:11px" class="${d0Ret!=null&&d0Ret>=0?'positive':'negative'}">${d0h?fmt.rate(d0Ret):'—'}</div></div>
        <div><div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">1주일 최고가 (${dayLbl})</div><div style="font-weight:700;color:var(--positive)">${fmt.won(wHigh)}</div><div style="font-size:11px;font-weight:600" class="${wRet!=null&&wRet>=0?'positive':'negative'}">${wHigh?fmt.rate(wRet):'—'}</div></div>
        <div><div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">최적 매도</div><div style="font-size:13px;font-weight:700">${dayLbl}</div><div style="font-size:11px;color:var(--text3)">고가 기준</div></div>
      </div>
    </div>`;
  }
  el('modal-body').innerHTML=`
    ${perfHTML}
    <div class="metric-row">
      <div class="metric-box"><div class="l">공모가</div><div class="v price">${fmtPriceBand(ipo)}</div></div>
      <div class="metric-box"><div class="l">청약일</div><div class="v" style="font-size:15px">${ipo.subscribeStart?fmtDate(ipo.subscribeStart):'—'}${ipo.subscribeEnd&&ipo.subscribeEnd!==ipo.subscribeStart?'~'+fmtDate(ipo.subscribeEnd):''}</div></div>
      <div class="metric-box"><div class="l">주관사</div><div class="v" style="font-size:14px;line-height:1.45">${(ipo.securities&&ipo.securities.length)?ipo.securities.map(h).join('<br>'):'미정'}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h2>청약 일정 · 상세</h2>
        <button class="panel-more" onclick="closeModal();switchTab('strategy');setTimeout(function(){focusStrategyIpo('${h(id)}')},60)">자세히 보기 →</button>
      </div>
      <table class="data-table"><tbody>
        <tr><td>청약일</td><td style="text-align:right;font-weight:600">${ipo.subscribeStart||'—'} ~ ${ipo.subscribeEnd||'—'}</td></tr>
        <tr><td>환불일</td><td style="text-align:right;font-weight:600">${ipo.refundDate||'—'}</td></tr>
        <tr><td>상장예정일</td><td style="text-align:right;font-weight:600">${ipo.listingDate||'—'}</td></tr>
        ${lockupReleaseDate(ipo)?`<tr><td>보호예수 해제일</td><td style="text-align:right;font-weight:600;color:var(--navy)">${lockupReleaseDate(ipo)}</td></tr>`:''}
      </tbody></table>
    </div>
    ${riskPanel(ipo)}
    ${reviewInfoPanels(ipo)}
    ${_calcWidget(ipo)}`;
  el('modal-foot').innerHTML=`
    <button class="btn btn-ghost" id="wl-btn" onclick="toggleWl('${h(id)}')">${watchlist.some(w=>String(w)===String(id))?'☆ 관심 해제':'⭐ 관심 추가'}</button>
    ${isAdmin?`<button class="btn btn-ghost" onclick="closeModal();openAdminEdit('${h(id)}')">수정</button><button class="btn btn-danger" onclick="deleteIpo('${h(id)}')">삭제</button>`:''}
  `;
  el('ipo-modal').classList.add('show');
  logAction('ipo_view', id);
}
function closeModal(){ el('ipo-modal').classList.remove('show'); }

// ─────────────────────────────────────────────────────────────
// 균등 참여 최소 금액 안내 (모달 내 위젯) — 계산기 대체
// ─────────────────────────────────────────────────────────────
function _calcWidget(ipo){
  const price=ipo.finalPrice||ipo.priceRange?.[1]||0;
  if(!price) return ''; // 공모가 없으면 표시 안 함
  const minUnit=10; // 일반적인 최소 청약 단위 10주
  // 균등 참여 최소 증거금 (검증·보정 포함 공통 헬퍼)
  const minDeposit=_minDeposit(ipo);
  const totalApply=minDeposit*2;
  return `
    <div class="panel" style="margin-top:13px">
      <div class="panel-head">
        <h2>💰 균등 참여 최소 금액</h2>
        <button class="panel-more" onclick="closeModal();switchTab('planner');setTimeout(function(){pickAllocIpo('${h(ipo.id)}')},60)">배정 계산기 →</button>
      </div>
      <div style="padding:18px">
        <div class="min-equal-hero">
          <div class="min-equal-label">이 종목 균등 청약에 필요한 최소 증거금</div>
          <div class="min-equal-amount">${minDeposit.toLocaleString('ko-KR')}원</div>
          <div class="min-equal-sub">최소 청약 ${minUnit}주 · 신청금액 ${totalApply.toLocaleString('ko-KR')}원의 50%</div>
        </div>
        <div class="min-equal-note">
          💡 <strong>균등 배정</strong>은 청약 건수에 관계없이 청약자에게 공평하게 나눠주는 방식입니다.
          최소 단위(보통 ${minUnit}주)만 청약해도 균등 배정 대상에 포함되므로,
          위 금액만 있으면 참여할 수 있습니다.
          <br>※ 증거금율 50% 기준, 공모가는 ${ipo.finalPrice?'확정가':'희망가 상단'} 기준입니다. 실제 최소 단위·증거금율은 증권사별로 다를 수 있습니다.
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// (캘린더 추가 .ics 다운로드 기능 제거 — 사용자 요청 #1)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 통합 검색 (상단 돋보기)
// ─────────────────────────────────────────────────────────────
function openSearch(){
  let overlay=el('search-overlay');
  if(!overlay){
    overlay=document.createElement('div');
    overlay.id='search-overlay';
    overlay.style.cssText='position:fixed;inset:0;background:rgba(11,25,41,.5);backdrop-filter:blur(4px);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh';
    overlay.innerHTML=`
      <div style="background:var(--panel);border-radius:16px;width:90%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden" onclick="event.stopPropagation()">
        <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border)">
          <span style="font-size:18px">🔍</span>
          <input id="search-input" type="text" placeholder="종목명, 섹터, 주관사 검색..." oninput="runSearch(this.value)" style="flex:1;border:none;outline:none;font-size:15px;background:transparent;color:var(--text)">
          <button onclick="closeSearch()" style="width:28px;height:28px;border-radius:7px;background:var(--bg2);border:1px solid var(--border);color:var(--text2);font-size:14px;cursor:pointer">✕</button>
        </div>
        <div id="search-results" style="max-height:50vh;overflow-y:auto;padding:8px"></div>
      </div>`;
    overlay.onclick=closeSearch;
    document.body.appendChild(overlay);
  }
  overlay.style.display='flex';
  el('search-input').value='';
  runSearch('');
  setTimeout(()=>el('search-input').focus(),50);
}
function closeSearch(){ const o=el('search-overlay'); if(o) o.style.display='none'; }
function runSearch(q){
  const term=(q||'').trim().toLowerCase();
  const results=el('search-results');
  let list=IPOS.slice();
  if(term){
    list=list.filter(i=>
      (i.name||'').toLowerCase().includes(term)||
      (i.sector||'').toLowerCase().includes(term)||
      (i.code||'').toLowerCase().includes(term)||
      (i.securities||[]).some(s=>s.toLowerCase().includes(term))
    );
  }
  // 상태순 정렬
  const order={active:0,upcoming:1,past:2,listed:3};
  list.sort((a,b)=>(order[calcStatus(a)]??9)-(order[calcStatus(b)]??9));
  list=list.slice(0,20);
  if(!list.length){ results.innerHTML='<div style="padding:32px;text-align:center;color:var(--text3);font-size:13px">검색 결과가 없습니다.</div>'; return; }
  results.innerHTML=list.map(i=>`
    <div onclick="closeSearch();switchTab('dashboard');openModal('${h(i.id)}')" style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:10px;cursor:pointer;transition:background .12s" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='transparent'">
      ${statusBadge(calcStatus(i))}
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px">${h(i.name)}</div><div style="font-size:11.5px;color:var(--text3);margin-top:2px">${h(i.sector||'—')} · ${(i.securities||[]).map(h).join(', ')||'주관사미정'}</div></div>
      <div style="font-size:12px;color:var(--text3);white-space:nowrap">${fmtDate(i.subscribeStart)}</div>
    </div>`).join('');
}
window.openSearch=openSearch;
window.closeSearch=closeSearch;
window.runSearch=runSearch;

function toggleWl(id){
  const sid=String(id);
  const i=watchlist.findIndex(w=>String(w)===sid);
  if(i>=0) watchlist.splice(i,1); else watchlist.push(sid);
  saveAll();
  if(el('wl-btn')) el('wl-btn').textContent=watchlist.some(w=>String(w)===sid)?'☆ 관심 해제':'⭐ 관심 추가';
  renderMyPage();
}

// ─────────────────────────────────────────────────────────────
// TAB: DASHBOARD (홈) — 히어로 stat 제거, 예정 3개 제한
// ─────────────────────────────────────────────────────────────
let homeFilter='all', homeView='card';

function renderDashboard(){
  const active  =IPOS.filter(i=>calcStatus(i)==='active');
  const upcoming=IPOS.filter(i=>calcStatus(i)==='upcoming');

  window._heroMonthData={
    active:{title:'청약중',list:[...active].sort((a,b)=>(a.subscribeEnd||a.subscribeStart||'').localeCompare(b.subscribeEnd||b.subscribeStart||''))},
    upcoming:{title:'청약예정',list:[...upcoming].sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'))}
  };
  el('hero-months').innerHTML=`
    <button class="hero-month-card" onclick="openMonthPop('active')">
      <div class="hmc-label">청약중</div>
      <div class="hmc-count">${active.length}<span>건</span></div>
    </button>
    <button class="hero-month-card" onclick="openMonthPop('upcoming')">
      <div class="hmc-label">청약예정</div>
      <div class="hmc-count">${upcoming.length}<span>건</span></div>
    </button>
    <div class="hero-month-card today">
      <div class="hmc-label"><span class="hmc-dot"></span>오늘</div>
      <div class="hmc-count" style="font-size:22px">${TODAY.getMonth()+1}<span>월</span> ${TODAY.getDate()}<span>일</span></div>
    </div>`;

  // 청약중 카드 (전체 표시)
  const sortedActive=[...active].sort((a,b)=>(a.subscribeStart||'').localeCompare(b.subscribeStart||''));
  el('home-active-count').textContent=` ${active.length}·청약 진행`;
  el('home-active-list').innerHTML=active.length===0
    ?`<div style="padding:26px 16px;text-align:center;background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius)">
        <div style="font-size:13.5px;color:var(--text2);font-weight:600;margin-bottom:4px">현재 청약 중인 종목이 없습니다</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:12px">${upcoming.length>0?`곧 시작될 청약 예정 종목 ${upcoming.length}개를 아래에서 확인해 보세요.`:'새 공모 일정이 등록되면 여기에 표시됩니다.'}</div>
        <button class="panel-more" onclick="switchTab('schedule')">공모주 일정 보기 →</button>
      </div>`
    :`<div class="home-card-grid">${sortedActive.map(ipoCard).join('')}</div>`;

  // 예정 카드 (최대 3개 + 더보기)
  const sortedUpcoming=[...upcoming].sort((a,b)=>(a.subscribeStart||'').localeCompare(b.subscribeStart||''));
  const shownUpcoming=sortedUpcoming.slice(0,3);
  const moreCount=sortedUpcoming.length-3;
  el('home-upcoming-count').textContent=` ${upcoming.length}·예정 공모`;
  if(upcoming.length===0){
    el('home-upcoming-list').innerHTML='<div style="padding:20px 16px;text-align:center;color:var(--text3);font-size:13px;background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius)">예정된 공모주가 없습니다.</div>';
  } else {
    el('home-upcoming-list').innerHTML=`
      <div class="home-card-grid">${shownUpcoming.map(ipoCard).join('')}</div>
      ${moreCount>0?`<button onclick="switchTab('schedule')" style="margin-top:12px;width:100%;padding:13px;background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-weight:700;color:var(--navy);cursor:pointer;transition:all .15s" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='var(--panel)'">자세히 보기</button>`:''}`;
  }

  // 홈 도넛차트 제거됨
  const chartsRow=el('home-charts-row');
  if(chartsRow){
    chartsRow.className='home-charts-row dashboard-support';
    chartsRow.innerHTML=renderDashboardSupport(active, upcoming);
  }
  arrangeDashboardLayout();
  renderMarketCtx();
  const newsBox=el('ipo-news-panel'); if(newsBox) newsBox.innerHTML='';
}

function arrangeDashboardLayout(){
  const root=el('tab-dashboard'); if(!root||root.querySelector('.dashboard-main-grid')) return;
  const pop=el('month-pop-bg');
  const grid=document.createElement('div');
  grid.className='dashboard-main-grid';
  const left=document.createElement('div');
  left.className='dashboard-left';
  const right=document.createElement('div');
  right.className='dashboard-right';
  grid.append(left,right);
  if(pop&&pop.parentNode) pop.insertAdjacentElement('afterend',grid);
  else root.appendChild(grid);
  const activeHead=el('home-active-count')&&el('home-active-count').closest('.section-head');
  const activeList=el('home-active-list');
  const upcomingHead=el('home-upcoming-count')&&el('home-upcoming-count').closest('.section-head');
  const upcomingList=el('home-upcoming-list');
  [activeHead,activeList,upcomingHead,upcomingList].forEach(n=>{ if(n) left.appendChild(n); });
  [el('market-ctx-bar'),el('home-charts-row')].forEach(n=>{ if(n) right.appendChild(n); });
}

function renderDashboardSupport(active, upcoming){
  const keyDate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayKey=keyDate(TODAY);
  // 임박 알림(D-2 이내): 오늘만이 아니라 곧 다가오는 청약·마감·환불·상장을 능동적으로 노출
  const dd=s=>{ if(!s) return null; return Math.ceil((new Date(s+'T00:00:00')-TODAY)/86400000); };
  const todayEvents=[];
  IPOS.filter(i=>!i.isSpac).forEach(i=>{
    const dS=dd(i.subscribeStart), dE=dd(i.subscribeEnd), dR=dd(i.refundDate), dL=dd(i.listingDate);
    if(dS!=null&&dS>=0&&dS<=2) todayEvents.push({d:dS,mark:'S',title:`${i.name} 청약 시작`,meta:`${(i.securities||[]).join(', ')||'주관사 미정'} · 최소 ${_minDeposit(i).toLocaleString('ko-KR')}원`,id:i.id});
    if(dE!=null&&dE>=0&&dE<=1) todayEvents.push({d:dE,mark:'M',title:`${i.name} 청약 마감`,meta:'마감 전 경쟁률과 증거금 확인',id:i.id});
    if(dR!=null&&dR>=0&&dR<=2) todayEvents.push({d:dR,mark:'R',title:`${i.name} 환불일`,meta:'환불금 재투입 가능 여부 확인',id:i.id});
    if(dL!=null&&dL>=0&&dL<=1) todayEvents.push({d:dL,mark:'L',title:`${i.name} 상장일`,meta:'초기 변동성과 매도 전략 확인',id:i.id});
  });
  todayEvents.sort((a,b)=>a.d-b.d);
  const ddLbl=n=>n===0?'오늘':`D-${n}`;
  const todoHtml=todayEvents.length?todayEvents.slice(0,6).map(t=>`
    <button class="todo-item" onclick="openModal('${h(t.id)}')">
      <span class="todo-mark">${t.mark}</span>
      <span><strong>${h(t.title)}</strong><span>${h(t.meta)}</span></span>
      <span class="todo-dday">${ddLbl(t.d)}</span>
    </button>`).join(''):`<div style="padding:22px;text-align:center;color:var(--text3);font-size:13px;background:var(--bg);border:1px solid var(--border-soft);border-radius:10px">2일 이내 다가오는 청약 일정이 없습니다.</div>`;

  // 미리 해두면 좋을 작업 — 급한 일정이 없어도 평소에 준비해두면 좋은 작업.
  // 마감 임박해서 하면 늦는 작업 위주로, 보유 데이터가 확보된 종목에 한해 자동 생성.
  const diffDays=s=>{ if(!s) return null; return Math.ceil((new Date(s+'T00:00:00')-TODAY)/86400000); };
  const prep=[];
  IPOS.filter(i=>!i.isSpac).forEach(i=>{
    // 1순위: 주관사 계좌 미리 개설 — 청약 시작 전 예정 종목 (20영업일 추가개설 제한 대비)
    const dStart=diffDays(i.subscribeStart);
    if(dStart!=null && dStart>=1 && dStart<=21){
      prep.push({mark:'계',cls:'',title:`${i.name} 주관사 계좌 개설`,meta:`${(i.securities||[]).join(', ')||'주관사 미정'} · 청약 전 미리 개설`,dday:dStart,id:i.id,sort:dStart});
    }
    // 1순위: 수요예측 결과 검토 — 청약 1~2일 전 + 경쟁률 데이터 확보 시에만
    const comp=i.competitionRate ?? i.institutionalCompetitionRate;
    if(dStart!=null && dStart>=1 && dStart<=2 && comp>0){
      prep.push({mark:'예',cls:'urgent',title:`${i.name} 수요예측 결과 검토`,meta:`기관 경쟁률 ${fmt.num(comp)}:1 · 의무확약·유통물량 확인`,dday:dStart,id:i.id,sort:dStart-0.5});
    }
    // 2순위: 보호예수 해제일 점검 — 해제일 데이터가 확보된 종목이 도래할 때만
    const rel=lockupReleaseDate(i), dRel=diffDays(rel);
    if(rel && dRel!=null && dRel>=0 && dRel<=30){
      prep.push({mark:'보',cls:'',title:`${i.name} 보호예수 해제 점검`,meta:'의무보유 해제 물량 출회 → 매도 타이밍 점검',dday:dRel,id:i.id,sort:dRel+0.1});
    }
  });
  prep.sort((a,b)=>a.sort-b.sort);
  const ddayLabel=d=>d>0?`D-${d}`:d===0?'D-Day':'';
  const prepHtml=prep.length?prep.slice(0,6).map(t=>`
    <button class="todo-item" onclick="openModal('${h(t.id)}')">
      <span class="todo-mark prep-mark ${t.cls}">${t.mark}</span>
      <span><strong>${h(t.title)}</strong><span>${h(t.meta)}</span></span>
      <span class="todo-dday">${ddayLabel(t.dday)}</span>
    </button>`).join(''):`<div style="padding:22px;text-align:center;color:var(--text3);font-size:13px;background:var(--bg);border:1px solid var(--border-soft);border-radius:10px">지금 미리 준비할 예정 일정이 없습니다.</div>`;
  // 3순위: 증권사별 청약 한도·우대조건 — 참고사항으로만 안내
  const prepRef=`<div class="prep-ref">참고 · 증권사별 청약 한도와 우대조건(주거래·온라인·연령 우대)을 미리 확인해 두면 청약일에 균등·비례 배정을 최대화할 수 있습니다.</div>`;

  return `
    <div class="dash-support-card">
      <div class="dash-support-title"><h2>오늘·임박 일정</h2><span class="pill">${todayEvents.length}개</span></div>
      <div class="todo-items">${todoHtml}</div>
    </div>
    <div class="dash-support-card" style="margin-top:16px">
      <div class="dash-support-title"><h2>미리 해두면 좋을 작업</h2><span class="pill">${prep.length}개</span></div>
      <div class="todo-items">${prepHtml}</div>
      ${prepRef}
    </div>`;
}

// 시장 맥락 위젯 — 실시간 코스피·코스닥 지수(/api/stock?type=liveindex, 장중) + 환율·투자심리.
// 15분 간격으로 자동 갱신. 실시간 수집 실패 시 전일(overview) 지수로 폴백.
let _marketCtxTimer=null;
function fmtClockKST(iso){ try{ return new Date(iso).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
function renderMarketCtx(){
  const box=el('market-ctx-bar'); if(!box) return;
  const load=()=>Promise.all([
    fetch(API_BASE+'/api/stock?type=overview',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
    fetch(API_BASE+'/api/hlprice',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
    fetch(API_BASE+'/api/stock?type=liveindex',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
  ]).then(([d,hl,li])=>{
    d=d||{};
    const fxHist=hl&&Array.isArray(hl.fxHistory)?hl.fxHistory:[];
    const latestFx=fxHist.length?Number(fxHist[fxHist.length-1].v):Number(hl&&hl.usdKrw);
    if(Number.isFinite(latestFx)&&latestFx>0) d={...d,usdKrw:latestFx,rateSource:'frankfurter',fxLive:true};
    // 실시간 지수 병합: 장중 데이터가 있으면 코스피·코스닥을 교체
    let live=false, liveTime=null;
    if(li && li.live && (li.kospi||li.kosdaq)){ d={...d, kospi:li.kospi||d.kospi, kosdaq:li.kosdaq||d.kosdaq}; live=true; liveTime=li.updatedAt; }
    const UP='#E23B3B', DN='#2563EB', FL='var(--text3)';   // 지수는 한국 관습(상승 빨강/하락 파랑)
    const idxChip=(label,o)=>{
      if(!o||o.price==null) return '';
      const c=o.rate>0?UP:o.rate<0?DN:FL, sign=o.rate>0?'▲':o.rate<0?'▼':'–';
      return `<div style="flex:1 1 calc(50% - 4px);min-width:0;padding:10px 12px;background:var(--panel);border:1px solid var(--border);border-radius:10px">
        <div style="font-size:11px;color:var(--text3);font-weight:600">${label}</div>
        <div style="font-size:16px;font-weight:800;font-variant-numeric:tabular-nums">${Number(o.price).toLocaleString('ko-KR')}</div>
        <div style="font-size:11.5px;font-weight:700;color:${c};font-variant-numeric:tabular-nums">${sign} ${o.rate>0?'+':''}${Number(o.rate||0).toFixed(2)}%</div>
      </div>`;
    };
    const fx=d.usdKrw!=null?`<div style="flex:1 1 calc(50% - 4px);min-width:0;padding:10px 12px;background:var(--panel);border:1px solid var(--border);border-radius:10px"><div style="font-size:11px;color:var(--text3);font-weight:600">원/달러</div><div style="font-size:16px;font-weight:800;font-variant-numeric:tabular-nums">${Number(d.usdKrw).toLocaleString('ko-KR')}원</div></div>`:'';
    const fngVal=(d.fng&&typeof d.fng==='object')?d.fng.score:d.fng;
    // 투자심리: 글로벌(CNN) 메인 + 국내 VKOSPI(전일) 보조. CNN 없으면 자체 지수기반 프록시로 폴백.
    const cnn=d.cnnFng, vk=d.vkospi;
    const cnnKo=r=>({'extreme fear':'극단적 공포','fear':'공포','neutral':'중립','greed':'탐욕','extreme greed':'극단적 탐욕'})[String(r||'').toLowerCase()]||'';
    const vkSub=(vk&&vk.value!=null)?`<div style="font-size:10px;color:var(--text3);margin-top:4px;white-space:nowrap">국내 VKOSPI(전일) <b style="color:var(--text2)">${Number(vk.value).toLocaleString('ko-KR')}</b></div>`:'';
    let _sent='';
    if(cnn&&cnn.score!=null){
      _sent=`<div style="font-size:11px;color:var(--text3);font-weight:600">글로벌 투자심리 <span style="font-size:9px">· CNN</span></div><div style="font-size:16px;font-weight:800;display:flex;align-items:baseline;gap:4px;white-space:nowrap">${cnn.score}<span style="font-size:11px;font-weight:600;color:var(--text3)">${cnnKo(cnn.rating)||fngLabelKo(cnn.score)}</span></div>${vkSub}`;
    } else if(fngVal!=null){
      _sent=`<div style="font-size:11px;color:var(--text3);font-weight:600">투자심리 <span style="font-size:9px">· 참고(지수기반)</span></div><div style="font-size:16px;font-weight:800;display:flex;align-items:baseline;gap:4px;white-space:nowrap">${fngVal}<span style="font-size:11px;font-weight:600;color:var(--text3)">${fngLabelKo(fngVal)}</span></div>${vkSub}`;
    }
    const fng=_sent?`<div style="flex:1 1 calc(50% - 4px);min-width:0;padding:10px 12px;background:var(--panel);border:1px solid var(--border);border-radius:10px">${_sent}</div>`:'';
    const chips=[idxChip('코스피',d.kospi),idxChip('코스닥',d.kosdaq),fx,fng].filter(Boolean).join('');
    if(!chips){ box.innerHTML=''; return; }
    const liveBadge=live?`<span style="display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:800;color:#fff;background:#E23B3B;padding:2px 7px;border-radius:999px;white-space:nowrap">● 실시간</span>`:'';
    const basisText=live?`장중 실시간 · ${fmtClockKST(liveTime)} 기준 · 15분 간격 갱신${d.fxLive?' · 환율 실시간':''}`:`${d.basisDate?d.basisDate+' 지수 기준':'전일 지수 기준'}${d.fxLive?' · 환율 실시간 반영':''}`;
    box.innerHTML=`<div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px"><span style="font-size:13px;font-weight:700;white-space:nowrap">시장 지표</span>${liveBadge}</div>
      <div style="font-size:11px;color:var(--text3);line-height:1.5;margin-bottom:9px">${basisText}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;max-width:100%">${chips}</div></div>`;
  }).catch(()=>{ /* 갱신 실패 시 기존 표시 유지 */ });
  load();
  if(_marketCtxTimer) clearInterval(_marketCtxTimer);
  _marketCtxTimer=setInterval(load, 15*60*1000);   // 15분마다 홈페이지 지수 자동 갱신
}

// 공모주·증시 뉴스 — /api/stock?type=news (이미 공모/IPO/증시 키워드 필터). 데이터 없으면 숨김.
function renderIpoNews(){
  const box=el('ipo-news-panel'); if(!box) return;
  fetch(API_BASE+'/api/stock?type=news',{cache:'no-store'}).then(r=>r.json()).then(d=>{
    const list=(d&&d.list)||[];
    if(!list.length){ box.innerHTML=''; return; }
    const esc=s=>String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const rows=list.slice(0,10).map(n=>`<a href="${esc(n.link)}" target="_blank" rel="noopener" style="display:block;padding:11px 14px;border-bottom:1px solid var(--border-soft);text-decoration:none;color:inherit">
      <div style="font-size:13.5px;font-weight:600;line-height:1.4">${esc(n.title)}</div>
      <div style="font-size:11px;color:var(--text3);margin-top:3px">${n.source?esc(n.source)+' · ':''}${relTimeKo(n.pubDate)}</div></a>`).join('');
    box.innerHTML=`<div class="section-head"><div><h2 style="display:inline">📰 공모주·증시 뉴스</h2></div></div>
      <div style="background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</div>`;
  }).catch(()=>{ box.innerHTML=''; });
}
function relTimeKo(iso){ try{ const t=new Date(iso); const m=Math.floor((Date.now()-t)/60000); if(m<1) return '방금'; if(m<60) return m+'분 전'; const h=Math.floor(m/60); if(h<24) return h+'시간 전'; return Math.floor(h/24)+'일 전'; }catch(e){ return ''; } }
function fngLabelKo(v){ if(v==null) return ''; return v<=24?'극단적 공포':v<=44?'공포':v<=55?'중립':v<=74?'탐욕':'극단적 탐욕'; }

// 뉴스 탭 — /api/stock?type=news (공모/IPO/증시 키워드 필터). 6개씩 페이지 전환.
let newsTabPage=0;
let newsTabList=[];

function renderNewsTab(){
  const box=el('tab-news'); if(!box) return;
  box.innerHTML='<div class="section-head" style="margin-top:0"><div><h2 style="display:inline">📰 공모주·증시 뉴스</h2><span class="sub">공모·IPO·청약·증시 관련 주요 뉴스</span></div></div><div id="news-tab-list" style="padding:24px;text-align:center;color:var(--text3)">불러오는 중…</div>';
  fetch(API_BASE+'/api/stock?type=news',{cache:'no-store'}).then(r=>r.json()).then(d=>{
    newsTabList=(d&&d.list)||[];
    newsTabPage=0;
    renderNewsPage();
  }).catch(()=>{ const wrap=el('news-tab-list'); if(wrap) wrap.innerHTML='<div style="padding:30px;text-align:center;color:var(--text3)">뉴스를 불러오지 못했습니다.</div>'; });
}

function renderNewsPage(){
  const wrap=el('news-tab-list'); if(!wrap) return;
  const list=newsTabList||[];
  if(!list.length){ wrap.innerHTML='<div style="padding:30px;text-align:center;color:var(--text3)">표시할 뉴스가 없습니다.</div>'; return; }
  const esc=s=>String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const per=6;
  const total=Math.max(1,Math.ceil(list.length/per));
  newsTabPage=Math.min(Math.max(newsTabPage,0),total-1);
  const start=newsTabPage*per;
  const rows=list.slice(start,start+per).map(n=>`<a href="${esc(n.link)}" target="_blank" rel="noopener" style="display:block;padding:14px 16px;border-bottom:1px solid var(--border-soft);text-decoration:none;color:inherit">
    <div style="font-size:14px;font-weight:600;line-height:1.45">${esc(n.title)}</div>
    <div style="font-size:11.5px;color:var(--text3);margin-top:4px">${n.source?esc(n.source)+' · ':''}${relTimeKo(n.pubDate)}</div></a>`).join('');
  wrap.outerHTML=`<div id="news-tab-list">
    <div style="background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</div>
    <div class="news-pager">
      <button onclick="moveNewsPage(-1)" ${newsTabPage===0?'disabled':''}>이전</button>
      <span style="font-size:12.5px;color:var(--text3);font-weight:700">${newsTabPage+1} / ${total}</span>
      <button onclick="moveNewsPage(1)" ${newsTabPage>=total-1?'disabled':''}>다음</button>
    </div>
  </div>`;
}

function moveNewsPage(delta){
  newsTabPage+=delta;
  renderNewsPage();
}
window.moveNewsPage=moveNewsPage;

// 월별 청약 종목 팝업
function openMonthPop(which){
  const data=window._heroMonthData&&window._heroMonthData[which];
  if(!data) return;
  const list=data.list;
  const title=data.title||`${data.m+1}월 청약 종목`;
  el('month-pop').innerHTML=`
    <div class="month-pop-head">
      <h3>${title} <span>${list.length}건</span></h3>
      <button class="month-pop-close" onclick="closeMonthPop()">✕</button>
    </div>
    <div class="month-pop-body">
      ${list.length?list.map(i=>`
        <button class="month-pop-item" onclick="closeMonthPop();openModal('${h(i.id)}')">
          <div class="mpi-main">
            <span class="mpi-name">${h(i.name)}</span>
            <span class="mpi-sector">${h(i.sector||'')}</span>
          </div>
          <div class="mpi-date">${fmtDate(i.subscribeStart)}${i.subscribeEnd&&i.subscribeEnd!==i.subscribeStart?'~'+fmtDate(i.subscribeEnd):''}</div>
        </button>`).join('')
        :'<div style="padding:30px;text-align:center;color:var(--text3);font-size:13.5px">이 달에는 청약 예정 종목이 없습니다.</div>'}
    </div>`;
  el('month-pop-bg').classList.add('show');
}
window.openMonthPop=openMonthPop;
function closeMonthPop(e){
  if(e && e.target!==el('month-pop-bg')) return; // 배경 클릭만 닫힘(버튼 클릭은 인자 없음)
  el('month-pop-bg').classList.remove('show');
}
window.closeMonthPop=closeMonthPop;

// ── (사용 안 함) 홈 도넛 차트 ──
function _renderDashboardCharts(){
  return; // 도넛차트 제거됨
  // eslint-disable-next-line no-unreachable
  const row=el('home-charts-row'); if(!row) return;
  const statusCounts={ active:IPOS.filter(i=>calcStatus(i)==='active').length, upcoming:IPOS.filter(i=>calcStatus(i)==='upcoming').length, listed:IPOS.filter(i=>calcStatus(i)==='listed'&&!i.isSpac).length, past:IPOS.filter(i=>calcStatus(i)==='past').length };
  const sectorMap={};
  IPOS.filter(i=>!i.isSpac).forEach(i=>{ const s=i.sector||'기타'; sectorMap[s]=(sectorMap[s]||0)+1; });
  const sectorEntries=Object.entries(sectorMap).sort((a,b)=>b[1]-a[1]);
  row.innerHTML=`
    <div class="donut-card"><div class="donut-card-title">공모주 현황</div><div class="donut-and-legend"><div class="donut-canvas-wrap"><canvas id="chart-status"></canvas></div><div class="donut-legend" id="legend-status"></div></div></div>
    <div class="donut-card"><div class="donut-card-title">섹터 분포</div><div class="donut-and-legend"><div class="donut-canvas-wrap"><canvas id="chart-sector"></canvas></div><div class="donut-legend" id="legend-sector"></div></div></div>`;
  if(!window.Chart){ const t=setInterval(()=>{ if(window.Chart){ clearInterval(t); _drawDashboardCharts(statusCounts,sectorEntries); } },150); return; }
  _drawDashboardCharts(statusCounts,sectorEntries);
}

function _drawDashboardCharts(statusCounts,sectorEntries){
  const statusItems=[{label:'청약중',count:statusCounts.active,color:'#E84545'},{label:'예정',count:statusCounts.upcoming,color:'#2563EB'},{label:'상장',count:statusCounts.listed,color:'#16A34A'},{label:'종료',count:statusCounts.past,color:'#94A3B8'}].filter(i=>i.count>0);
  const ctx1=el('chart-status');
  if(ctx1){ const ex=Chart.getChart(ctx1); if(ex) ex.destroy(); new Chart(ctx1,{type:'doughnut',data:{labels:statusItems.map(i=>i.label),datasets:[{data:statusItems.map(i=>i.count),backgroundColor:statusItems.map(i=>i.color),borderWidth:0,hoverOffset:4}]},options:{plugins:{legend:{display:false},tooltip:{enabled:false}},cutout:'68%',responsive:true,maintainAspectRatio:true,animation:{duration:600}}}); el('legend-status').innerHTML=statusItems.map(i=>`<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${i.color}"></span><span class="donut-legend-label">${i.label}</span><span class="donut-legend-val">${i.count}</span></div>`).join(''); }
  const sectorColors=['#2563EB','#16A34A','#F59E0B','#E84545','#8B5CF6','#EC4899','#6B7280','#0891B2'];
  const ctx2=el('chart-sector');
  if(ctx2){ const ex=Chart.getChart(ctx2); if(ex) ex.destroy(); new Chart(ctx2,{type:'doughnut',data:{labels:sectorEntries.map(([s])=>s),datasets:[{data:sectorEntries.map(([,c])=>c),backgroundColor:sectorColors,borderWidth:0,hoverOffset:4}]},options:{plugins:{legend:{display:false},tooltip:{enabled:false}},cutout:'68%',responsive:true,maintainAspectRatio:true,animation:{duration:600}}}); el('legend-sector').innerHTML=sectorEntries.map(([s,c],i)=>`<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${sectorColors[i%sectorColors.length]}"></span><span class="donut-legend-label">${s}</span><span class="donut-legend-val">${c}</span></div>`).join(''); }
}

// ─────────────────────────────────────────────────────────────
// TAB: CALENDAR — 사이드 하단 이동
// ─────────────────────────────────────────────────────────────
let calView={y:TODAY.getFullYear(),m:TODAY.getMonth()};
let calSel=null;
let scheduleView='calendar';
const WDAYS=['일','월','화','수','목','금','토'];

function ensureScheduleSubtabs(){
  const tab=el('tab-calendar'); if(!tab) return;
  if(!el('schedule-subtabs')){
    const row=document.createElement('div');
    row.className='schedule-subtabs';
    row.id='schedule-subtabs';
    row.innerHTML=`
      <button class="schedule-subtab" data-view="calendar" onclick="setScheduleView('calendar')">캘린더</button>
      <button class="schedule-subtab" data-view="list" onclick="setScheduleView('list')">전체일정</button>`;
    const head=tab.querySelector('.section-head');
    if(head) head.insertAdjacentElement('afterend',row);
    else tab.prepend(row);
  }
  if(!el('cal-schedule-list')){
    const list=document.createElement('div');
    list.id='cal-schedule-list';
    list.style.display='none';
    const wrap=tab.querySelector('.cal-wrap');
    if(wrap) wrap.insertAdjacentElement('afterend',list);
    else tab.appendChild(list);
  }
}

function setScheduleView(view){
  scheduleView=view==='list'?'list':'calendar';
  renderCalendar();
}
window.setScheduleView=setScheduleView;

function renderCalendar(){
  ensureScheduleSubtabs();
  qsa('#schedule-subtabs .schedule-subtab').forEach(b=>b.classList.toggle('on',b.dataset.view===scheduleView));
  const calWrapEl=qs('#tab-calendar .cal-wrap');
  const listEl=el('cal-schedule-list');
  if(scheduleView==='list'){
    if(calWrapEl) calWrapEl.style.display='none';
    if(listEl) listEl.style.display='block';
    renderUnifiedScheduleList();
    return;
  }
  if(listEl) listEl.style.display='none';
  if(calWrapEl) calWrapEl.style.display='grid';
  const calSideEl=qs('#tab-calendar .cal-side');
  if(calSideEl) calSideEl.style.display='block';
  const oldAgenda=el('cal-agenda'); if(oldAgenda) oldAgenda.remove();

  const events=buildEvents(IPOS);
  if(!calSel) calSel=new Date(TODAY);
  el('cal-month-label').textContent=`${calView.y}년 ${calView.m+1}월`;
  el('cal-dow').innerHTML=WDAYS.map(d=>`<div>${d}</div>`).join('');
  const first=new Date(calView.y,calView.m,1);
  const start=new Date(first); start.setDate(1-first.getDay());
  let cells='';
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i);
    const isO=d.getMonth()!==calView.m;
    const isT=d.toDateString()===TODAY.toDateString();
    const isS=calSel&&d.toDateString()===calSel.toDateString();
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const evs=events[k]||[];
    const tLabel={sub:'청약',ref:'환불',lst:'상장',lock:'확약해제'};
    cells+=`<div class="cal-day ${isO?'other':''} ${isT?'today':''} ${isS?'sel':''}" data-k="${k}" data-ts="${d.getTime()}">
      <div class="cal-num">${d.getDate()}</div>
      ${evs.slice(0,3).map(e=>`<div class="cal-mini t-${e.type}" title="[${tLabel[e.type]}] ${h(e.ipo.name)}"><span class="lbl">[${tLabel[e.type]}]</span>${h(e.ipo.name)}</div>`).join('')}
      ${evs.length>3?`<div class="cal-mini" style="background:var(--bg2);color:var(--text3);font-weight:600">+${evs.length-3}건</div>`:''}
    </div>`;
  }
  el('cal-grid').innerHTML=cells;
  // 클릭은 #cal-grid에 위임(초기화 1회)되어 있으므로 셀마다 리스너를 붙이지 않음(메모리 누수 방지)
  renderCalAgenda(events);
}

// 하단 월별 일정 목록 — 날짜별 인라인 목록형 (예: 5월7일 [청약] 폴레드 [상장] 신한스팩18호)
function renderCalAgenda(events){
  const sideEvents=el('cal-sel-events');
  const agendaEl=sideEvents||el('cal-agenda'); if(!agendaEl) return;
  const typeLabel={sub:'청약',ref:'환불',lst:'상장',lock:'확약해제'};
  // 선택한 날짜가 없으면 안내만
  if(!calSel){
    if(el('cal-sel-date')) el('cal-sel-date').textContent='날짜를 선택하세요';
    if(el('cal-sel-sub')) el('cal-sel-sub').textContent='';
    agendaEl.innerHTML=`<div style="text-align:center;color:var(--text3);font-size:14px;padding:24px 0">📅 날짜를 클릭하면 해당 날짜의 일정이 표시됩니다.</div>`;
    return;
  }
  const y=calSel.getFullYear(), m=calSel.getMonth()+1, d=calSel.getDate();
  const key=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const evs=events[key]||[];
  const depositItems=IPOS.filter(i=>!i.isSpac && i.subscribeStart===key).map(i=>({ipo:i, amount:_minDeposit(i)}));
  const depositTotal=depositItems.reduce((s,x)=>s+x.amount,0);
  const depositBox=`<div class="cal-deposit-card">
    <div class="l">해당일 예상 필요 증거금</div>
    <div class="v">${depositTotal.toLocaleString('ko-KR')}원</div>
    <div class="d">${depositItems.length?depositItems.map(x=>`${h(x.ipo.name)} ${x.amount.toLocaleString('ko-KR')}원`).join(' · '):'청약 시작 종목 기준, 해당일 필요 증거금 없음'}</div>
  </div>`;
  const w=['일','월','화','수','목','금','토'][calSel.getDay()];
  if(el('cal-sel-date')) el('cal-sel-date').textContent=`${m}월 ${d}일 (${w})`;
  if(el('cal-sel-sub')) el('cal-sel-sub').textContent=`일정 ${evs.length}건`;
  agendaEl.innerHTML=depositBox
    +(evs.length===0
      ?'<div style="text-align:center;color:var(--text3);font-size:13px;padding:20px 0">이 날짜에는 일정이 없습니다.</div>'
      :`<div class="cal-side-list">
          ${evs.map(e=>`<button class="cal-side-item" onclick="openModal('${h(e.ipo.id)}')"><strong>[${typeLabel[e.type]}] ${h(e.ipo.name)}</strong><span>${h(e.ipo.sector||'섹터 미정')} · ${fmtPriceBand(e.ipo)}</span></button>`).join('')}
        </div>`);
}

// ─────────────────────────────────────────────────────────────
// TAB: SCHEDULE — 청약일정(청약중+예정) / 지난청약(상장예정+상장완료)
// ─────────────────────────────────────────────────────────────
let schedFilter='current'; // 'current'(청약일정) | 'past'(지난청약)

function _schedTable(rows){
  return `<div class="ipo-list-table">
    <div class="ipo-list-head"><div>섹터</div><div>종목명</div><div>공모가</div><div>청약일</div><div class="ipo-list-lastcol">${rows.lastLabel}</div><div>경쟁률</div><div>주관사</div></div>
    ${rows.html||`<div style="padding:36px;text-align:center;color:var(--text3)">${rows.emptyMsg||'해당 종목이 없습니다.'}</div>`}
  </div>`;
}

function scheduleListHtml(){
  if(schedFilter==='current'){
    // 청약중 → 청약예정. 청약중이 최상단.
    const active=IPOS.filter(i=>calcStatus(i)==='active')
      .sort((a,b)=>(a.subscribeEnd||a.subscribeStart||'').localeCompare(b.subscribeEnd||b.subscribeStart||''));
    const upcoming=IPOS.filter(i=>calcStatus(i)==='upcoming')
      .sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'));
    return `
      <div class="sched-section">
        <div class="sched-section-head"><span class="sched-section-label">청약중</span><span class="sched-section-count">${active.length}개</span></div>
        ${_schedTable({lastLabel:'환불일', html:active.map(ipoListRow).join(''), emptyMsg:'진행 중인 청약이 없습니다.'})}
      </div>
      <div class="sched-section">
        <div class="sched-section-head"><span class="sched-section-label">청약예정</span><span class="sched-section-count">${upcoming.length}개</span></div>
        ${_schedTable({lastLabel:'환불일', html:upcoming.map(ipoListRow).join('')})}
      </div>
      <div class="sched-spac-note">ℹ️ 스팩(SPAC) 종목은 목록에서 생략되었습니다.</div>`;
  } else {
    // 지난청약: 상장예정(prelisting) + 상장완료(listed). 최근 청약일이 위로.
    const past=IPOS.filter(i=>{const s=calcStatus(i);return s==='past'||s==='listed';})
      .sort((a,b)=>(b.subscribeStart||'').localeCompare(a.subscribeStart||''));
    return `
      <div class="sched-section">
        ${_schedTable({lastLabel:'상장일', html:past.map(ipoListRow).join('')})}
      </div>
      <div class="sched-spac-note">ℹ️ 스팩(SPAC) 종목은 목록에서 생략되었습니다.</div>`;
  }
}

function renderSchedule(){
  const count=el('schedule-count'); if(count) count.textContent='';
  const list=el('schedule-list'); if(list) list.innerHTML=scheduleListHtml();
}

function setScheduleFilter(filter){
  schedFilter=filter==='past'?'past':'current';
  renderSchedule();
  if(scheduleView==='list') renderUnifiedScheduleList();
}
window.setScheduleFilter=setScheduleFilter;

function renderUnifiedScheduleList(){
  const box=el('cal-schedule-list'); if(!box) return;
  box.innerHTML=`
    <div class="sched-header">
      <span class="sched-list-desc">청약중·예정과 지난 청약을 한 화면에서 확인합니다</span>
      <div class="filter-chips" style="margin-bottom:0">
        <button class="chip ${schedFilter==='current'?'on':''}" onclick="setScheduleFilter('current')">청약일정</button>
        <button class="chip ${schedFilter==='past'?'on':''}" onclick="setScheduleFilter('past')">지난청약</button>
      </div>
    </div>
    ${scheduleListHtml()}`;
}

// ─────────────────────────────────────────────────────────────
// TAB: STRATEGY — 도넛 제거, 주관사 전체, 클릭 버그 수정
// ─────────────────────────────────────────────────────────────
let stratPick=null;
let workspaceTab='subscribe';

function setWorkspaceTab(name){
  workspaceTab=name;
  renderStrategy();
}
window.setWorkspaceTab=setWorkspaceTab;

function renderWorkspace(){
  const root=el('tab-strategy');
  if(!root) return;
  root.innerHTML=`
    <div class="workspace-shell">
      <div class="workspace-head">
        <div>
          <h2>청약 정보</h2>
          <p>청약 예정·진행 종목과 지난 청약의 일정, 최소 증거금, 추천도를 정리했습니다.</p>
        </div>
        <button class="btn btn-ghost" onclick="switchTab('schedule')">전체일정 보기</button>
      </div>
      <div class="workspace-panel" id="workspace-body"></div>
    </div>`;
  workspaceTab='subscribe';
  renderWorkspaceSubscribe();
}

function workspaceTargets(){
  const cur=IPOS.filter(i=>{const s=calcStatus(i);return (s==='active'||s==='upcoming')&&!i.isSpac;})
    .sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'));
  const past=IPOS.filter(i=>{const s=calcStatus(i); if(i.isSpac) return false;
      if(s==='past') return true;                       // 상장예정(최근)
      if(s==='listed') return isWithinMonths(i.listingDate,6); // 상장완료는 6개월 이내만
      return false; })
    .sort((a,b)=>(b.subscribeStart||'').localeCompare(a.subscribeStart||''));
  return { cur, past, all:[...cur, ...past] };
}

// 회사 한줄 설명: 전용 필드 우선, 없으면 섹터 기반 폴백, 둘 다 없으면 표시 안 함
function companyDesc(ipo){
  if(ipo.businessSummary) return ipo.businessSummary;
  if(ipo.sector && ipo.sector!=='미정') return `${ipo.sector} 분야 기업`;
  return '';
}

function renderWorkspaceSubscribe(){
  const box=el('workspace-body'); if(!box) return;
  const { cur, past, all }=workspaceTargets();
  if(!all.length){ box.innerHTML='<div style="padding:34px;text-align:center;color:var(--text3)">표시할 공모주가 없습니다.</div>'; return; }
  if(!stratPick||!all.find(i=>String(i.id)===String(stratPick))) stratPick=String((cur[0]||all[0]).id);
  const pick=all.find(i=>String(i.id)===String(stratPick));
  const sectorTxt=i=>(i.sector&&i.sector!=='미정')?' · '+h(i.sector):'';
  const listBtn=(i,sub)=>`<button class="workspace-ipo-btn ${String(stratPick)===String(i.id)?'on':''}" onclick="stratPickIpo('${h(i.id)}')">
    <span><strong>${h(i.name)}</strong><small>${sub}</small></span>
    ${starRating(i)}
  </button>`;
  const upcomingLabel=cur.length?`<div class="workspace-list-divider first">청약 예정</div>`:'';
  const curHtml=cur.map(i=>listBtn(i, `${fmtDate(i.subscribeStart)}${sectorTxt(i)}`)).join('');
  const pastRow=i=>`<button class="workspace-past-btn ${String(stratPick)===String(i.id)?'on':''}" onclick="stratPickIpo('${h(i.id)}')"><span class="wpb-name">${h(i.name)}</span><span class="wpb-date">${i.listingDate?'상장 '+fmtDate(i.listingDate):'상장 미정'}</span></button>`;
  const pastHtml=past.length?`<div class="workspace-list-divider">지난 청약</div>`+past.map(pastRow).join(''):'';
  // 종목명 아래 한 줄(섹터 기반) + 중앙 회사 개요 패널(상세)
  const sectorShort = (pick&&pick.sector&&pick.sector!=='미정') ? `${h(pick.sector)} 분야 기업` : '';
  const detailText = pick ? (pick.businessSummary ? h(pick.businessSummary)
      : (pick.sector&&pick.sector!=='미정' ? `${h(pick.sector)} 분야 기업입니다. 상세 사업·수익구조 개요는 준비 중입니다.` : '상세 개요는 준비 중입니다.')) : '';
  box.innerHTML=`
    <div class="workspace-list">
      <div class="workspace-ipo-list">
        ${upcomingLabel}${curHtml}${pastHtml}
      </div>
      <div>
        ${pick?`
          <div class="strat-overview">
            <div class="strat-overview-top">
              <div class="strat-title-block">
                <div class="strat-name-line"><h3>${h(pick.name)}</h3></div>
                <div class="strat-meta-line">${(pick.sector&&pick.sector!=='미정')?`<span class="strat-sector-tag compact">${h(pick.sector)}</span>`:''}${statusBadge(calcStatus(pick))}${starRating(pick)}</div>
                ${sectorShort?`<div class="strat-company-desc">${sectorShort}</div>`:''}
              </div>
              <div class="strat-risk-top">${riskBadgeGroup(pick,false)}</div>
            </div>
            <div class="strat-focus-grid">
              <div class="sf-item price"><span>공모가</span><b>${fmtPriceBand(pick)}</b></div>
              <div class="sf-item"><span>청약일</span><b>${fmtDate(pick.subscribeStart)}${pick.subscribeEnd&&pick.subscribeEnd!==pick.subscribeStart?'~'+fmtDate(pick.subscribeEnd):''}</b></div>
              <div class="sf-item"><span>최소 증거금</span><b>${fmt.won(_minDeposit(pick))}</b></div>
            </div>
          </div>
          <div class="strat-detail-split" style="margin-top:14px">
            <div class="strat-company-panel">
              <div class="scp-title">🏢 회사 개요</div>
              <div class="scp-body">${detailText}</div>
            </div>
            <div class="strat-detail-panel">
              <div class="sdp-head"><span>청약 세부 조건</span><b>일정·주관사·배정</b></div>
              <table class="data-table strat-compact-table"><tbody>
                ${infoRow('주관사', h((pick.securities||[]).join(', ')||'미정'))}
                ${infoRow('수요예측 경쟁률', pick.competitionRate?fmt.num(pick.competitionRate)+':1':'미정')}
                ${infoRow('환불일', pick.refundDate||'미정')}
                ${infoRow('상장예정일', pick.listingDate||'미정')}
                ${infoRow('의무보유확약', fmtPct(pick.lockup ?? pick.lockupTotalRatio))}
                ${infoRow('상장 직후 유통가능 비율', fmtPct(pick.tradableRatioAfterListing))}
              </tbody></table>
            </div>
          </div>`:''}
      </div>
    </div>`;
}

function renderWorkspaceSell(){
  const box=el('workspace-body'); if(!box) return;
  const listed=IPOS.filter(i=>calcStatus(i)==='listed'&&!i.isSpac).sort((a,b)=>(b.listingDate||'').localeCompare(a.listingDate||'')).slice(0,6);
  if(!listed.length){ box.innerHTML='<div style="padding:34px;text-align:center;color:var(--text3)">매도 전략을 계산할 상장 완료 종목이 없습니다.</div>'; return; }
  box.innerHTML=`<div class="workspace-sell-grid">
    ${listed.map(i=>{
      const cur=getCurrentPrice(i);
      const ret=calcReturn(i.finalPrice,cur);
      const db=globalHistoryPrices[i.code]||{};
      const weekHigh=db.weekHigh||null;
      const weekRet=calcReturn(i.finalPrice,weekHigh);
      return `<div class="workspace-sell-card" onclick="switchTab('performance');setTimeout(function(){trackerPick('${h(i.id)}')},80)">
        <strong>${h(i.name)}</strong>
        <div class="big" style="color:${ret==null?'var(--text)':ret>=0?'var(--gain)':'var(--loss)'}">${cur?fmt.won(cur):'시세 대기'}</div>
        <div class="sub">현재 수익률 ${ret==null?'미정':fmt.rate(ret)} · 1주 최고 ${weekRet==null?'미정':fmt.rate(weekRet)}</div>
        <div style="margin-top:10px">${timingBadge(i)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderWorkspaceAlloc(){
  const box=el('workspace-body'); if(!box) return;
  const pool=_plannerPool();
  const allPlan=_routePlanForPool(pool,0);
  const first=pool[0];
  const est=first?_estimateAllocation(first, plannerState.asset, plannerState.userRate):null;
  box.innerHTML=`<div class="workspace-alloc-grid">
    <div class="workspace-alloc-card">
      <strong>배정 계산</strong>
      <div class="big">${first?h(first.name):'대기'}</div>
      <div class="sub">${est?`균등 ${est.equalPerPerson}주 · 비례 ${est.propShares}주 예상`:'청약 가능 종목이 없습니다.'}</div>
      <button class="panel-more" style="margin-top:12px" onclick="switchTab('planner')">상세 계산 열기</button>
    </div>
    <div class="workspace-alloc-card">
      <strong>균등 루트</strong>
      <div class="big">${allPlan.needed.toLocaleString('ko-KR')}원</div>
      <div class="sub">전체 ${pool.length}개 균등 참여 최소 준비금</div>
      <button class="panel-more" style="margin-top:12px" onclick="switchTab('planner')">루트 최적화 열기</button>
    </div>
    <div class="workspace-alloc-card">
      <strong>추천 흐름</strong>
      <div class="big">${pool.length?fmtDate(pool[0].subscribeStart):'미정'}</div>
      <div class="sub">가장 빠른 청약일부터 증거금과 환불일을 확인하세요.</div>
    </div>
  </div>`;
}

function renderStrategy(){
  return renderWorkspace();
  // 청약 시작일 빠른 순(오름차순)으로 정렬
  const targets=IPOS.filter(i=>calcStatus(i)==='active'||calcStatus(i)==='upcoming')
    .sort((a,b)=>(a.subscribeStart||'9999').localeCompare(b.subscribeStart||'9999'));
  // 지난 청약은 최근 청약일이 위로(내림차순)
  const past   =IPOS.filter(i=>calcStatus(i)==='past'||calcStatus(i)==='listed')
    .sort((a,b)=>(b.subscribeStart||'').localeCompare(a.subscribeStart||''));
  if(!stratPick&&targets.length) stratPick=String(targets[0].id);
  const pick=IPOS.find(i=>String(i.id)===String(stratPick));

  // 좌측 종목 카드: 종목명(크게) + 청약일(MM/DD~MM/DD) + 섹터 + AI 리포트 더미
  function stratItemHTML(s, isPast){
    const start=s.subscribeStart?fmtDate(s.subscribeStart):'';
    const end  =s.subscribeEnd&&s.subscribeEnd!==s.subscribeStart?fmtDate(s.subscribeEnd):'';
    const dateRange=start?(end?`${start}~${end}`:start):'청약일 미정';
    return `<button class="strat-item ${String(stratPick)===String(s.id)?'on':''}" onclick="stratPickIpo('${s.id}')">
      <div class="t" ${isPast?'style="color:var(--text3)"':''}>${s.name}${gradeChip(s)}</div>
      <div class="strat-date">📅 ${dateRange}</div>
      <span class="strat-sector">${s.sector||'섹터미정'}</span>
    </button>`;
  }
  // 지난 청약: 목록형 (한 줄에 종목명 + 청약일)
  function stratPastRow(s){
    const start=s.subscribeStart?fmtDate(s.subscribeStart):'';
    const end  =s.subscribeEnd&&s.subscribeEnd!==s.subscribeStart?fmtDate(s.subscribeEnd):'';
    const dateRange=start?(end?`${start}~${end}`:start):'미정';
    return `<button class="strat-past-row ${String(stratPick)===String(s.id)?'on':''}" onclick="stratPickIpo('${s.id}')">
      <span class="spr-name">${s.name}</span>
      <span class="spr-date">${dateRange}</span>
    </button>`;
  }

  el('strat-list').innerHTML=[
    ...targets.map(s=>stratItemHTML(s,false)),
    past.length?`<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-soft)">
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">지난 청약</div>
      <div class="strat-past-list">${past.slice(0,5).map(stratPastRow).join('')}</div>
      ${past.length>5?`<button class="strat-past-more" onclick="switchTab('schedule')">지난 청약 ${past.length-5}개 더보기</button>`:''}
    </div>`:''
  ].join('');

  if(!pick){ el('strat-detail').innerHTML='<div style="padding:40px;text-align:center;color:var(--text3)">종목을 선택하세요</div>'; return; }

  // 우측: 공모가 / 청약일 / 주관사 먼저 강조, 섹터 표기 크게
  const allSecurities=(pick.securities||[]).join(', ')||'주관사 미정';
  const firstSec=pick.securities&&pick.securities[0]||'미정';
  const extraSec=pick.securities&&pick.securities.length>1?` 외 ${pick.securities.length-1}개`:'';
  const startD=pick.subscribeStart?fmtDate(pick.subscribeStart):'—';
  const endD  =pick.subscribeEnd&&pick.subscribeEnd!==pick.subscribeStart?'~'+fmtDate(pick.subscribeEnd):'';

  el('strat-detail').innerHTML=`
    <div class="strat-overview">
      <div class="strat-overview-top">
        <div class="strat-title-block">
          <div class="strat-name-line">
            <h3>${h(pick.name)}</h3>
            <span>${h(pick.code||'코드미정')}</span>
          </div>
          <div class="strat-meta-line">
            <span class="strat-sector-tag compact">${h(pick.sector||'섹터미정')}</span>
            ${statusBadge(calcStatus(pick))}
            ${gradeSummaryChip(pick)}
          </div>
        </div>
        <div class="strat-risk-top">${riskBadgeGroup(pick,false)}</div>
      </div>
      <div class="strat-focus-grid">
        <div class="sf-item price"><span>공모가</span><b>${fmtPriceBand(pick)}</b></div>
        <div class="sf-item"><span>청약일</span><b>${startD}${endD}</b></div>
        <div class="sf-item"><span>최소 증거금</span><b>${fmt.won(_minDeposit(pick))}</b></div>
      </div>
    </div>

    <div class="strat-folds">
      <details class="strat-fold" open>
        <summary><span>요약 리포트</span><b>핵심 해석</b></summary>
        <div class="strat-report-compact">${pick.aiReport ? h(pick.aiReport) : '아직 등록된 분석 리포트가 없습니다.'}</div>
      </details>
      <details class="strat-fold">
        <summary><span>리스크·등급 근거</span><b>배지 산정 이유</b></summary>
        ${strategyRiskSummary(pick)}
        ${strategyGradeSummary(pick)}
      </details>
      <details class="strat-fold">
        <summary><span>청약 세부 조건</span><b>일정·배정 정보</b></summary>
        <table class="data-table strat-compact-table"><tbody>
          ${infoRow('주관사 전체', h(allSecurities))}
          ${infoRow('대표 주관사', h(firstSec)+h(extraSec))}
          ${infoRow('수요예측 경쟁률', pick.competitionRate?fmt.num(pick.competitionRate)+':1':'미정')}
          ${infoRow('환불일', pick.refundDate||'—')}
          ${infoRow('상장예정일', pick.listingDate||'—')}
          ${infoRow('의무보유 확약', fmtPct(pick.lockup ?? pick.lockupTotalRatio))}
          ${infoRow('상장 직후 유통가능 비율', fmtPct(pick.tradableRatioAfterListing))}
          ${infoRow('균등배정 예상', pick.equalShares?pick.equalShares+'주':'—')}
          ${infoRow('액면가', pick.faceValue?fmt.won(pick.faceValue):'500원 (추정)')}
        </tbody></table>
      </details>
      <details class="strat-fold">
        <summary><span>종목 비교표</span><b>${targets.length}개 청약 예정 비교</b></summary>
        ${renderMiniCompareTable(targets, pick.id)}
      </details>
    </div>`;
}
window.stratPickIpo=id=>{ stratPick=String(id); renderStrategy(); };
// 모달 "자세히 보기 →"로 청약정보 탭 진입 시 해당 종목 선택
function focusStrategyIpo(id){
  stratPick=String(id);
  renderStrategy();
  const list=el('strat-list');
  if(list){ const on=list.querySelector('.strat-item.on, .strat-past-row.on'); if(on&&on.scrollIntoView) on.scrollIntoView({block:'nearest'}); }
}
window.focusStrategyIpo=focusStrategyIpo;

// ─────────────────────────────────────────────────────────────
// TAB: PERFORMANCE
// ─────────────────────────────────────────────────────────────
let trackerSelected=null, trackerChart=null;

function renderPerformance(){
  renderLockupWatch();
  const listedIpos=IPOS.filter(i=>calcStatus(i)==='listed'&&!i.isSpac&&isWithinMonths(i.listingDate,6)).sort((a,b)=>(b.listingDate||'').localeCompare(a.listingDate||''));
  if(!listedIpos.length){
    el('tracker-tabs').innerHTML='<div style="color:var(--text3);font-size:13px">상장 완료 종목이 없습니다.</div>';
    el('tracker-stats').innerHTML='';
    renderHistoryTable();
    return;
  }
  if(!trackerSelected||!listedIpos.find(i=>String(i.id)===String(trackerSelected.id))) trackerSelected=listedIpos[0];
  el('tracker-tabs').innerHTML=listedIpos.map(i=>`<button class="tracker-tab ${String(trackerSelected.id)===String(i.id)?'active':''}" onclick="trackerPick('${i.id}')">${h(i.name)}${i.code?`<span class="code">${h(i.code)}</span>`:''}</button>`).join('');
  updateTrackerView();
  renderHistoryTable();
}

window.trackerPick=id=>{
  trackerSelected=IPOS.find(i=>String(i.id)===String(id))||trackerSelected;
  el('tracker-tabs').querySelectorAll('.tracker-tab').forEach(t=>{ const m=t.getAttribute('onclick').match(/'([^']+)'/); if(m) t.classList.toggle('active',m[1]===String(id)); });
  updateTrackerView();
};

function updateTrackerView(){
  const t=trackerSelected; if(!t) return;
  const db=globalHistoryPrices[t.code]||{};
  const finalP=t.finalPrice||0;
  const hasDbData=Object.keys(db).length>0;
  const highs=[0,1,2,3,4,5,6,7].map(n=>db[`d${n}High`]??null);
  const weekHigh=db.weekHigh??(highs.filter(Boolean).length?Math.max(...highs.filter(Boolean)):null);
  const weekHighDay=db.weekHighDay??highs.indexOf(weekHigh);
  const weekRet=calcReturn(finalP,weekHigh);
  const d0High=highs[0]; const d0Ret=calcReturn(finalP,d0High);
  let timingStr='⏳ 동기화 필요';
  if(hasDbData&&weekHigh){ const dl=['D+0(상장당일)','D+1','D+2','D+3','D+4','D+5','D+6','D+7']; if(weekHighDay===0) timingStr='⚡ 상장 당일 매도 유리'; else if(weekHighDay===7) timingStr='📅 D+7 보유 매도 유리'; else timingStr=`🎯 ${dl[weekHighDay]} 매도 최적`; }
  const validDays=highs.filter(Boolean).length;
  const sourceLabel=hasDbData?`<span style="color:#4ade80">● 실시간 시세 수집 (${validDays}일치)</span>`:`<span style="color:#fbbf24">● 미동기화</span>`;
  // 현재가: 공통 기준 (prices_latest 우선, 없으면 history 종가)
  let curPrice=getCurrentPrice(t);
  const curRet=calcReturn(finalP,curPrice);
  const asOf=currentPriceAsOf(t);
  const asOfStr=asOf?('기준: '+new Date(asOf).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})):'';
  el('tracker-stats').innerHTML=`
    <div class="stat-card"><span class="stat-label">확정 공모가</span><span class="stat-value">${fmt.won(finalP)}</span><span class="stat-sub" style="color:var(--text3)">상장일: ${t.listingDate||'—'}</span></div>
    <div class="stat-card"><span class="stat-label">현재가${priceInfoTip(t)}</span><span class="stat-value">${curPrice?fmt.won(curPrice):'—'}</span><span class="stat-sub ${curRet!=null&&curRet>=0?'positive':'negative'}">${curPrice?'수익률: '+fmt.rate(curRet):sourceLabel}</span></div>
    <div class="stat-card"><span class="stat-label">1주차 최고가</span><span class="stat-value" style="color:var(--positive)">${weekHigh?fmt.won(weekHigh):'—'}</span><span class="stat-sub ${weekRet!=null&&weekRet>=0?'positive':'negative'}">${weekHigh?'최고 수익률: '+fmt.rate(weekRet):sourceLabel}</span></div>
    <div class="stat-card peak"><span class="stat-label">🏆 1주차 최적 매도 타이밍</span><span class="stat-value" style="font-size:18px;letter-spacing:-.01em">${timingStr}</span><span class="stat-sub">${validDays}일치 고가 데이터 기반</span></div>`;
  el('tracker-chart-title').textContent=`${t.name} 상장일(${t.listingDate||'—'}) 이후 1주차 일자별 고가 흐름`;
  // 상한가 판정: 각 일자 고가가 "전일 종가(D+0은 공모가) 대비 +29.5% 이상"이면 상한가로 표시
  const closes=[0,1,2,3,4,5,6,7].map(n=>db[`d${n}Close`]??null);
  const limitFlags=[false]; // index 0 = 공모가 자리(상한가 개념 없음)
  highs.forEach((hi,n)=>{
    const prevClose = n===0 ? finalP : closes[n-1];
    let isLimit=false, pct=null;
    if(hi!=null && prevClose && prevClose>0){
      pct=(hi-prevClose)/prevClose*100;
      if(pct>=29.5) isLimit=true;
    }
    limitFlags.push(isLimit?{pct}:false);
  });
  renderTrackerChart(t,[finalP,...highs],limitFlags);
  loadFullDailyChart(t, finalP);
}

// 상장일~현재 전체 일봉을 받아 차트를 전체기간으로 갱신 (없으면 기존 1주차 차트 유지)
const trackerDailyCache={};
async function loadFullDailyChart(t, finalP){
  if(!t||!t.code||!t.listingDate) return;
  let daily=trackerDailyCache[t.code];
  if(daily===undefined){
    try{
      const r=await fetch(API_BASE+`/api/price?code=${encodeURIComponent(t.code)}&since=${encodeURIComponent(t.listingDate)}`,{cache:'no-store'});
      const j=r.ok?await r.json():null;
      daily=(j&&Array.isArray(j.daily))?j.daily:[];
    }catch{ daily=[]; }
    trackerDailyCache[t.code]=daily;
  }
  // 비동기 사이 다른 종목을 선택했으면 무시
  if(!trackerSelected||String(trackerSelected.id)!==String(t.id)) return;
  if(!daily||daily.length<=8) return; // 전체기간이 1주치 이하면 기존 차트 유지
  const highsAll=daily.map(d=>d.high??null);
  const closesAll=daily.map(d=>d.close??null);
  const prices=[finalP, ...highsAll];
  const closes=[finalP, ...closesAll];
  const limitFlags=[false];
  prices.forEach((hi,n)=>{
    if(n===0) return;
    const prevClose=closes[n-1];
    let f=false;
    if(hi!=null && prevClose && prevClose>0){ const pct=(hi-prevClose)/prevClose*100; if(pct>=29.5) f={pct}; }
    limitFlags.push(f);
  });
  const labels=['공모가', ...daily.map(d=>{ const dd=new Date(d.date+'T00:00:00'); return `${dd.getMonth()+1}/${dd.getDate()}`; })];
  el('tracker-chart-title').textContent=`${t.name} 상장일(${t.listingDate||'—'}) 이후 전체 일자별 고가 흐름 (${daily.length}거래일)`;
  renderTrackerChart(t, prices, limitFlags, labels);
}

function renderTrackerChart(t,prices,limitFlags,customLabels){
  // X축: '공모가' + 상장일(D+0)부터 영업일 기준 실제 날짜 (customLabels가 오면 그대로 사용)
  const fmtMD=d=>`${d.getMonth()+1}/${d.getDate()}`;
  let labels;
  if(customLabels && customLabels.length){
    labels=customLabels.slice();
  } else {
    labels=['공모가'];
    const lst=t.listingDate?new Date(t.listingDate+'T00:00:00'):null;
    if(lst){
      let cur=new Date(lst);
      for(let n=0;n<8;n++){
        while(cur.getDay()===0||cur.getDay()===6){ cur.setDate(cur.getDate()+1); }
        labels.push(fmtMD(cur));
        cur.setDate(cur.getDate()+1);
      }
    } else {
      ['D+0','D+1','D+2','D+3','D+4','D+5','D+6','D+7'].forEach(l=>labels.push(l));
    }
  }
  const data=prices.map(p=>p!=null?p:null);
  let last=0; data.forEach((v,i)=>{ if(v!=null) last=i; });
  const filled=data.slice(0,last+1);
  const labelsFilled=labels.slice(0,filled.length);
  const flags=(limitFlags||[]).slice(0,filled.length);
  const canvas=el('tracker-chart'); if(!canvas) return;
  if(trackerChart){ trackerChart.destroy(); trackerChart=null; }
  if(typeof Chart==='undefined'){ return; }
  // 최고가 지점 인덱스 (공모가 자리 0 제외)
  let peakIdx=-1, peakVal=-Infinity;
  filled.forEach((v,i)=>{ if(i>0&&v!=null&&v>peakVal){ peakVal=v; peakIdx=i; } });
  // 포인트 강조: 최고가=금색 별 크게, 상한가=빨강, 공모가=금색 (포인트가 많으면 일반 점은 숨김)
  const many=filled.length>16;
  const baseR=many?0:4;
  const ptRadius=filled.map((_,i)=>i===peakIdx?8:(flags[i]?7:(i===0?5:baseR)));
  const ptColor =filled.map((_,i)=>i===peakIdx?'#C8973A':(flags[i]?'#E63946':(i===0?'#C8973A':'#1E3A5F')));
  const ptStyle =filled.map((_,i)=>i===peakIdx?'star':'circle');
  // 상한가 + 최고가 라벨을 그리는 커스텀 플러그인
  const limitLabelPlugin={
    id:'limitLabel',
    afterDatasetsDraw(chart){
      const {ctx}=chart;
      const meta=chart.getDatasetMeta(0);
      function pill(pt,txt,bg,above){
        ctx.save();
        ctx.font="700 11px 'Pretendard',sans-serif";
        const tw=ctx.measureText(txt).width;
        const padX=7,bw=tw+padX*2,bh=20;
        let by=above?pt.y-34:pt.y+14;
        if(by<2) by=pt.y+14;
        const rx=Math.max(2,Math.min(pt.x-bw/2,chart.width-bw-2));
        ctx.fillStyle=bg;
        const rr=6;
        ctx.beginPath();
        ctx.moveTo(rx+rr,by);ctx.arcTo(rx+bw,by,rx+bw,by+bh,rr);ctx.arcTo(rx+bw,by+bh,rx,by+bh,rr);ctx.arcTo(rx,by+bh,rx,by,rr);ctx.arcTo(rx,by,rx+bw,by,rr);ctx.closePath();ctx.fill();
        ctx.fillStyle='#fff';ctx.textBaseline='middle';ctx.textAlign='left';
        ctx.fillText(txt,rx+padX,by+bh/2+0.5);
        ctx.restore();
      }
      // 최고가 라벨 (위)
      if(peakIdx>0&&meta.data[peakIdx]){
        const base=filled[0];
        const r=base?((peakVal-base)/base*100):null;
        pill(meta.data[peakIdx], '🏆 최고가'+(r!=null?' +'+r.toFixed(1)+'%':''), '#C8973A', true);
      }
      // 상한가 라벨 (아래, 최고가와 같은 지점이면 생략)
      flags.forEach((f,i)=>{
        if(!f||filled[i]==null||i===peakIdx) return;
        pill(meta.data[i], '⬆ 상한가 +'+f.pct.toFixed(1)+'%', '#E63946', true);
      });
    }
  };
  const base=filled[0];
  trackerChart=new Chart(canvas.getContext('2d'),{
    type:'line',
    data:{ labels:labelsFilled, datasets:[{ label:'일별 고가', data:filled, borderColor:'#1E3A5F', backgroundColor:'rgba(30,58,95,.08)', fill:true, tension:0.4, cubicInterpolationMode:'monotone', pointRadius:ptRadius, pointHoverRadius:8, pointBackgroundColor:ptColor, pointStyle:ptStyle, pointBorderColor:'#fff', pointBorderWidth:2, spanGaps:true, borderWidth:2.5, order:0 },
      { label:base?`공모가 ${Number(base).toLocaleString('ko-KR')}원`:'공모가', data:filled.map(()=>base), borderColor:'#C8973A', borderWidth:1.5, borderDash:[5,4], pointRadius:0, pointHoverRadius:0, fill:false, tension:0, spanGaps:true, order:1 }]},
    options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false}, animation:{duration:400,easing:'easeOutQuart'}, layout:{padding:{top:30,right:8,bottom:0,left:0}},
      plugins:{ legend:{display:true,align:'end',labels:{font:{family:"'Pretendard',sans-serif",size:11.5},color:'#3D5A7A',usePointStyle:true,pointStyleWidth:10,boxHeight:7}},
        tooltip:{ bodyFont:{family:"'Pretendard',sans-serif",size:12}, titleFont:{family:"'Pretendard',sans-serif",weight:'600',size:12}, backgroundColor:'rgba(15,37,64,.92)', padding:10, cornerRadius:8, displayColors:false,
          callbacks:{ label:ctx=>`${ctx.dataset.label}: ${ctx.raw!=null?Number(ctx.raw).toLocaleString('ko-KR')+'원':'데이터 없음'}`, afterLabel:ctx=>{ const lines=[]; const base=filled[0]; if(base&&ctx.raw!=null&&ctx.dataIndex>0){ const r=((ctx.raw-base)/base*100); lines.push(`공모가 대비: ${r>=0?'+':''}${r.toFixed(1)}%`); } if(ctx.dataIndex===peakIdx) lines.push('🏆 1주차 최고가'); if(flags[ctx.dataIndex]) lines.push(`⬆ 상한가 (전일 대비 +${flags[ctx.dataIndex].pct.toFixed(1)}%)`); return lines; } }
        }
      },
      scales:{ x:{display:true,grid:{display:false},border:{display:true,color:'rgba(0,0,0,.08)'},ticks:{font:{family:"'Pretendard',sans-serif",size:11.5,weight:'600'},color:'#3D5A7A',autoSkip:filled.length>14,maxTicksLimit:filled.length>14?12:undefined,maxRotation:0,padding:6}}, y:{display:true,beginAtZero:false,grid:{color:'rgba(0,0,0,.05)',drawBorder:false},border:{display:false},ticks:{font:{family:"'Pretendard',sans-serif",size:11},color:'#7A92A8',padding:8,maxTicksLimit:6,callback:v=>Number(v).toLocaleString('ko-KR')},grace:'8%'} }
    },
    plugins:[limitLabelPlugin]
  });
}

// ─────────────────────────────────────────────────────────────
// HISTORY TABLE — 카드형, 인라인 스타일로 CSS 의존성 제거
// ─────────────────────────────────────────────────────────────
function timingBadge(ipo){
  const db=globalHistoryPrices[ipo.code]||{};
  const wHighDay=db.weekHighDay;
  const highs=[0,1,2,3,4,5,6,7].map(n=>db[`d${n}High`]??null);
  const hasData=highs.some(v=>v!=null);
  if(!hasData) return `<span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:7px;font-size:11px;font-weight:700;background:var(--border-soft);color:var(--text3)">데이터 집계중</span>`;
  const dayLabels=['상장 당일','D+1','D+2','D+3','D+4','D+5','D+6','D+7'];
  const bestDay=wHighDay??highs.reduce((best,v,i)=>v!=null&&(highs[best]??-Infinity)<v?i:best,0);
  const colors={0:'background:rgba(22,163,74,.1);color:#16A34A',7:'background:rgba(30,58,95,.1);color:var(--navy)'};
  const c=colors[bestDay]||'background:rgba(200,151,58,.1);color:#8A6310';
  return `<span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:7px;font-size:11px;font-weight:700;${c}">${dayLabels[bestDay]||'—'}</span>`;
}

// 🔒 보호예수(의무확약) 해제 워치 — 해제일 임박 종목(오버행 주의)을 가까운 순으로
function renderLockupWatch(){
  const box=el('lockup-watch'); if(!box) return;
  const items=IPOS
    .map(i=>({ ipo:i, date:lockupReleaseDate(i) }))
    .filter(x=>x.date)
    .map(x=>{ const d=new Date(x.date+'T00:00:00'); return { ipo:x.ipo, date:x.date, ts:d.getTime(), dday:Math.ceil((d-TODAY)/86400000) }; })
    .filter(x=>!isNaN(x.ts) && x.dday>=-3)         // 임박 + 막 지난 것(3일)까지
    .sort((a,b)=>a.ts-b.ts)
    .slice(0,12);
  if(!items.length){
    box.innerHTML=`<div class="panel" style="padding:16px;margin-bottom:14px"><div style="font-weight:700;font-size:14px;margin-bottom:3px">🔒 보호예수 해제 워치</div><div style="font-size:12px;color:var(--text3)">등록된 보호예수·의무확약 해제 예정일이 없습니다. (관리자 입력 또는 공시 추출 시 표시됩니다)</div></div>`;
    return;
  }
  const rows=items.map(x=>{
    const i=x.ipo;
    const ddayStr = x.dday>0?`D-${x.dday}` : x.dday===0?'D-Day' : `${-x.dday}일 전`;
    const ddayColor = x.dday<=3 ? 'var(--negative)' : (x.dday<=14 ? '#E08A1E' : 'var(--text3)');
    const lockPct = (i.lockup ?? i.lockupTotalRatio);
    const floatPct = i.tradableRatioAfterListing;
    const meta=[ lockPct!=null?`의무확약 ${lockPct}%`:null, floatPct!=null?`상장후 유통 ${floatPct}%`:null ].filter(Boolean).join(' · ');
    return `<div onclick="openModal('${h(i.id)}')" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border:1px solid var(--border);border-radius:10px;background:var(--panel);cursor:pointer">
      <div style="min-width:0">
        <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h(i.name)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${x.date}${meta?' · '+meta:''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-weight:800;font-size:14px;color:${ddayColor}">${ddayStr}</div>
        <div style="font-size:10.5px;color:var(--text3)">보호예수 해제</div>
      </div>
    </div>`;
  }).join('');
  box.innerHTML=`<div class="panel" style="padding:16px;margin-bottom:14px">
    <div style="font-weight:700;font-size:14px;margin-bottom:10px">🔒 보호예수 해제 워치 <span style="font-weight:500;font-size:11px;color:var(--text3)">· 해제일 전후 매물 출회(오버행) 주의</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">${rows}</div>
  </div>`;
}

function renderHistoryTable(){
  const wrap=document.querySelector('.history-table-wrap');
  if(!wrap) return;
  const all=IPOS.filter(i=>calcStatus(i)==='listed'&&isWithinMonths(i.listingDate,6)).sort((a,b)=>(b.listingDate||'').localeCompare(a.listingDate||''));
  if(!all.length){
    wrap.innerHTML='<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">상장 완료 종목이 없습니다.</div>';
    return;
  }
  wrap.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border-soft)">
      <h2 style="font-size:14px;font-weight:700">📋 공모주 매도 전략 성적표</h2>
      <span style="font-size:12px;color:var(--text3)">공모가 대비 수익률 · 1주일 최고가 매도 기준</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:16px" id="history-cards"></div>`;

  const grid=el('history-cards'); if(!grid) return;
  grid.innerHTML=all.map(ipo=>{
    const db=globalHistoryPrices[ipo.code]||{};
    const base=ipo.finalPrice||0;
    const weekHigh=db.weekHigh||ipo.firstDayClose||null;
    let returnPct=null;
    if(base&&weekHigh) returnPct=((weekHigh-base)/base*100);
    const returnColor=returnPct==null?'var(--text3)':returnPct>=0?'var(--gain)':'var(--loss)';
    const returnStr  =returnPct==null?'데이터 없음':`${returnPct>=0?'+':''}${returnPct.toFixed(1)}%`;
    // 현재가: 공통 기준 (prices_latest 우선, 없으면 history 종가)
    let curPrice=getCurrentPrice(ipo);
    const curRet=(base&&curPrice)?((curPrice-base)/base*100):null;
    const curColor=curRet==null?'var(--text3)':curRet>=0?'var(--gain)':'var(--loss)';
    return `<div onclick="trackerPick('${ipo.id}')" style="background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius-sm,9px);padding:14px 16px;cursor:pointer;transition:all .18s;box-shadow:var(--shadow-sm)" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='var(--shadow-md)';this.style.borderColor='rgba(30,58,95,.18)'" onmouseout="this.style.transform='';this.style.boxShadow='var(--shadow-sm)';this.style.borderColor='var(--border)'">
      <div style="margin-bottom:12px">
        <div style="font-size:15px;font-weight:800;letter-spacing:-.02em">${ipo.name}</div>
        <div style="font-size:10.5px;color:var(--text3);font-family:monospace;margin-top:2px">${ipo.code||'—'}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-size:11px;color:var(--text3);font-weight:600;margin-bottom:1px">현재가 (수익률)${priceInfoTip(ipo)}</div>
          <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${curColor};line-height:1.1">${curPrice?curPrice.toLocaleString()+'원':'—'}${curRet!=null?` <span style="font-size:13px">(${curRet>=0?'+':''}${curRet.toFixed(1)}%)</span>`:''}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);font-weight:600;margin-bottom:1px">최고가 (수익률) · 1주일 최고가 매도 기준</div>
          <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${returnColor};line-height:1.1">${weekHigh?weekHigh.toLocaleString()+'원':'—'}${returnPct!=null?` <span style="font-size:13px">(${returnPct>=0?'+':''}${returnPct.toFixed(1)}%)</span>`:''}</div>
        </div>
      </div>
      <div style="height:1px;background:var(--border-soft);margin-bottom:8px"></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:var(--text3)">공모가</span><span style="font-weight:600">${base?base.toLocaleString()+'원':'—'}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--text3)">상장일</span><span style="font-weight:600">${ipo.listingDate||'—'}</span></div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// SYNC
// ─────────────────────────────────────────────────────────────
async function forceUpdateHistory(){
  const pw=prompt('관리자 암호를 입력하세요'); if(!pw) return;
  const listedWithCode=IPOS.filter(i=>calcStatus(i)==='listed'&&i.code&&/^[A-Za-z0-9]{6}$/.test(i.code));
  const missing=listedWithCode.filter(i=>!(globalHistoryPrices[i.code]?.d0High));
  const hasStored=listedWithCode.filter(i=>globalHistoryPrices[i.code]?.d0High);
  const forceAll=hasStored.length>0&&confirm(`저장된 데이터 ${hasStored.length}개 종목도 다시 받아올까요?\n(취소: 누락된 ${missing.length}개만 동기화)`);
  const targets=forceAll?listedWithCode:missing;
  if(!targets.length){ alert('동기화할 종목이 없습니다.'); return; }
  const baseUrl=window.location.origin;
  const testRes=await fetch(`${baseUrl}/api/cron-update`).catch(()=>null);
  if(!testRes||!testRes.ok){ let updated=0; targets.forEach(ipo=>{ if(ipo.d0High){ globalHistoryPrices[ipo.code]={d0High:ipo.d0High,d1Close:ipo.d1Close||null,d2Close:ipo.d2Close||null,d3Close:ipo.d3Close||null}; updated++; } }); localStorage.setItem(HP_KEY,JSON.stringify(globalHistoryPrices)); renderHistoryTable(); if(trackerSelected) updateTrackerView(); alert(`로컬 모드: ${updated}개 동기화`); return; }
  let totalUpdated=0,totalFailed=[],toProcess=[...targets.map(i=>({code:i.code,listingDate:i.listingDate,name:i.name}))],round=0;
  while(toProcess.length>0){ round++; notify(`[${round}회차] ${toProcess.length}개 처리 중...`); const res=await fetch(`${baseUrl}/api/cron-update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminPw:pw,targets:toProcess,force:forceAll})}).then(r=>r.json()).catch(e=>({error:e.message})); if(res.error){ alert('오류: '+res.error); break; } totalUpdated+=res.updatedCount||0; (res.failedCodes||[]).forEach(c=>totalFailed.push(c)); if(!res.hasMore||!res.remaining||res.remaining.length===0) break; toProcess=res.remaining; await new Promise(r=>setTimeout(r,300)); }
  try{ const latest=await fetch(`${baseUrl}/api/cron-update`).then(r=>r.json()); globalHistoryPrices=latest||{}; localStorage.setItem(HP_KEY,JSON.stringify(globalHistoryPrices)); }catch(e){}
  renderHistoryTable(); if(trackerSelected) updateTrackerView();
  alert(`✅ 동기화 완료!\n• 업데이트: ${totalUpdated}개${totalFailed.length?`\n• 실패: ${totalFailed.join(', ')}`:''}` );
}

// 공공데이터 수집 cron 수동 실행 (재배포 후 데이터가 비어있을 때 즉시 채우기)
// /api/{path}?adminPw=관리자암호 를 호출 → 결과 표시 후 새로고침
async function runCron(path,label){
  const pw=prompt(`[${label}] 수동 실행\n관리자 암호를 입력하세요`); if(!pw) return;
  let res;
  try{
    res=await fetch(API_BASE+`/api/${path}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminPw: pw }) });
  }catch(e){ alert(`❌ ${label} 네트워크 오류: ${e.message}`); return; }
  const data=await res.json().catch(()=>({}));
  if(!res.ok){ alert(`❌ ${label} 실패 (HTTP ${res.status})\n${data.error||'응답 없음'}`); return; }
  alert(`✅ ${label} 완료\n\n${JSON.stringify(data).slice(0,400)}\n\n확인을 누르면 새로고침해 반영합니다.`);
  location.reload();
}
window.runCron=runCron;

// ─────────────────────────────────────────────────────────────
// TAB: ANALYSIS
// ─────────────────────────────────────────────────────────────
let analysisPick=null;
function renderAnalysis(){
  const targets=IPOS.filter(i=>calcStatus(i)==='active'||calcStatus(i)==='upcoming');
  const past   =IPOS.filter(i=>calcStatus(i)==='past'||calcStatus(i)==='listed');
  if(!analysisPick&&targets.length) analysisPick=String(targets[0].id);
  const pick=IPOS.find(i=>String(i.id)===String(analysisPick));
  el('analysis-content').innerHTML=targets.length===0?'<div style="padding:40px;text-align:center;color:var(--text3)">현재 분석 가능한 종목이 없습니다.</div>':`
    <div style="display:grid;grid-template-columns:190px 1fr;gap:16px">
      <div class="strat-list">${targets.map(s=>`<button class="strat-item ${String(analysisPick)===String(s.id)?'on':''}" onclick="analysisPickIpo('${s.id}')">
        <div class="t">${s.name}</div><div class="s">${s.sector||''}</div>
      </button>`).join('')}</div>
      <div>${pick?`
        <div class="panel" style="padding:18px;margin-bottom:13px">
          <div style="font-size:18px;font-weight:700;margin-bottom:4px">${pick.name}</div>
          <div style="font-size:12px;color:var(--text3)">${pick.sector||''} · ${pick.code||'코드미정'} · ${(pick.securities||[]).join(', ')||'주관사미정'}</div>
        </div>
        ${gradePanel(pick)}
        <div class="metric-row">
          <div class="metric-box"><div class="l">공모가</div><div class="v">${fmtPriceBand(pick)}</div></div>
          <div class="metric-box"><div class="l">경쟁률</div><div class="v">${pick.competitionRate?fmt.num(pick.competitionRate)+':1':'—'}</div></div>
          <div class="metric-box"><div class="l">의무보유확약</div><div class="v">${pick.lockup?pick.lockup+'%':'—'}</div></div>
        </div>
        <div class="update-notice"><div class="update-notice-icon">🔧</div><div class="update-notice-text"><strong>심층 분석 준비 중</strong><span>추가 분석 지표를 준비 중입니다.</span></div></div>`
        :'<div style="padding:40px;text-align:center;color:var(--text3)">종목을 선택하세요</div>'}
      </div>
    </div>
    ${past.length?`<div style="margin-top:32px"><div style="font-size:12px;color:var(--text3);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px">지난 공모주 (${past.length}건)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
        ${past.map(p=>`<div style="display:flex;align-items:center;justify-content:space-between;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:11px 14px;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;transition:all .12s" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='var(--panel)'" onclick="openModal('${p.id}')"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</span><span style="font-size:11px;color:var(--text3);flex-shrink:0;margin-left:8px">${fmtDate(p.subscribeStart)}</span></div>`).join('')}
      </div></div>`:''}`;
}
window.analysisPickIpo=id=>{ analysisPick=String(id); renderAnalysis(); };

// ─────────────────────────────────────────────────────────────
// TAB: MYPAGE
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 마이페이지: 내 청약 기록 대시보드
// ─────────────────────────────────────────────────────────────
const MYIPO_KEY='ipo_lounge_myrecords';
let myRecords=[];
function loadMyRecords(){ try{ myRecords=JSON.parse(localStorage.getItem(MYIPO_KEY)||'[]'); }catch(e){ myRecords=[]; } if(!Array.isArray(myRecords)) myRecords=[]; }
function saveMyRecords(){ localStorage.setItem(MYIPO_KEY, JSON.stringify(myRecords)); }

// 한 건의 손익 분해
// allocated: 배정 주수, soldShares: 매도한 주수, sellPrice: 매도 단가, ipoPrice: 공모가
// currentPrice: 보유분 평가용 현재가 (없으면 공모가로 대체해 평가손익 0)
function _recordBreakdown(r){
  const alloc=r.allocated||0;
  const sold=Math.min(r.soldShares||0, alloc);
  const held=Math.max(alloc-sold,0);
  const ipoP=r.ipoPrice||0;
  // 실현 손익 (매도분)
  const realized = (sold>0 && r.sellPrice!=null && ipoP) ? Math.round((r.sellPrice-ipoP)*sold) : 0;
  // 보유 평가 손익 (현재가 - 공모가) × 보유주수. 현재가 없으면 0
  const cur = r.currentPrice!=null ? r.currentPrice : null;
  const unrealized = (held>0 && cur!=null && ipoP) ? Math.round((cur-ipoP)*held) : 0;
  const heldValue = (held>0 && cur!=null) ? cur*held : 0;
  return { alloc, sold, held, ipoP, realized, unrealized, heldValue, total: realized+unrealized };
}

function renderMyPage(){
  loadMyRecords();
  syncRecordCurrentPrices(); // 보유 종목 현재가를 /api/price에서 비동기로 채움 (완료 시 자동 리렌더)
  const wi=IPOS.filter(i=>watchlist.some(w=>String(w)===String(i.id)));

  // 통계 집계
  const total=myRecords.length;
  const bds=myRecords.map(_recordBreakdown);
  const holdingCount=myRecords.filter((r,idx)=>bds[idx].held>0).length; // 보유 중(미매도분 있는) 건수
  const soldCount=myRecords.filter((r,idx)=>bds[idx].sold>0).length;    // 매도 완료(일부라도 매도한) 건수
  const realizedSum=bds.reduce((s,b)=>s+b.realized,0);
  const unrealizedSum=bds.reduce((s,b)=>s+b.unrealized,0);
  const totalProfit=realizedSum+unrealizedSum;
  const heldValueSum=bds.reduce((s,b)=>s+b.heldValue,0);

  el('mypage-content').innerHTML=`
    <!-- 수익 대시보드 4칸 -->
    <div class="dash-grid">
      <div class="dash-card">
        <div class="dash-label">총 청약</div>
        <div class="dash-value">${total}건</div>
        <div class="dash-sub">누적 참여 내역</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">보유 중</div>
        <div class="dash-value" style="color:var(--navy)">${holdingCount}건</div>
        <div class="dash-sub">${heldValueSum>0?`평가액 ${heldValueSum.toLocaleString()}원`:'미매도 보유분'}${holdingCount>0?` · <button class="dash-detail-btn" onclick="showHoldings()">자세히</button>`:''}</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">매도 완료</div>
        <div class="dash-value" style="color:var(--positive)">${soldCount}건</div>
        <div class="dash-sub">${realizedSum!==0?`실현손익 ${realizedSum>=0?'+':''}${realizedSum.toLocaleString()}원`:'매도 내역'}</div>
      </div>
      <div class="dash-card primary">
        <div class="dash-label">공모주 총 수익</div>
        <div class="dash-value ${totalProfit>=0?'pos':'neg'}">${totalProfit>=0?'+':''}${totalProfit.toLocaleString()}원</div>
        <div class="dash-sub">실현 ${realizedSum>=0?'+':''}${realizedSum.toLocaleString()} · 평가 ${unrealizedSum>=0?'+':''}${unrealizedSum.toLocaleString()}</div>
      </div>
    </div>

    <!-- 내 청약 기록 -->
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head" style="display:flex;justify-content:space-between;align-items:center">
        <h2>📒 내 청약 기록</h2>
        <button class="myrec-add-btn" onclick="openRecordForm()">+ 청약 기록 추가</button>
      </div>
      <div id="myrec-list">${_renderRecordList()}</div>
    </div>

    <div class="mypage-main">
      <div class="watchlist-card">
        <div class="panel-head" style="display:flex;justify-content:space-between;align-items:center"><h2>관심 종목</h2><span style="font-size:11.5px;color:var(--text3)">${wi.length}개</span></div>
        ${_renderWatchlistCards(wi)}
      </div>
      <div class="settings-card">
        <div class="panel-head"><h2>환경 설정</h2></div>
        <div class="settings-row"><div class="settings-row-label"><strong>알림</strong><span>청약 시작 1일 전 알림</span></div><div class="toggle-switch on" onclick="this.classList.toggle('on')"></div></div>
        <div class="settings-row"><div class="settings-row-label"><strong>상장일 알림</strong><span>상장일 당일</span></div><div class="toggle-switch on" onclick="this.classList.toggle('on')"></div></div>
        <div class="settings-row"><div class="settings-row-label"><strong>공시 알림</strong><span>관심 종목 공시 등록 시</span></div><div class="toggle-switch" onclick="this.classList.toggle('on')"></div></div>
      </div>
    </div>`;
}

// 기록의 보유 종목 현재가 조회
// 1순위: /api/price (prices_latest, cron-price가 매일 9시 저장)
// 2순위: globalHistoryPrices (history_prices, '시세 동기화' 버튼이 cron-update로 저장하는 D+0~D+7 종가)
async function syncRecordCurrentPrices(){
  const codes=[];
  myRecords.forEach(r=>{
    const ipo=IPOS.find(i=>i.name===r.name);
    const code=r.code||ipo?.code;
    if(code && !codes.includes(code)) codes.push(code);
    if(code && !r.code){ r.code=code; }
  });
  if(!codes.length) return;

  // 최신 history_prices를 다시 받아온다 (시세 동기화 직후 반영되도록)
  try{
    const hpRes=await fetch(API_BASE+'/api/cron-update');
    if(hpRes.ok){ const hp=await hpRes.json(); if(hp&&typeof hp==='object'){ Object.assign(globalHistoryPrices, hp); } }
  }catch(e){}

  // history_prices(시세 동기화 데이터)에서 가장 최근 종가를 현재가로 쓰는 헬퍼
  function fromHistory(code){
    const hp=globalHistoryPrices[code];
    if(!hp) return null;
    for(let n=7;n>=0;n--){ if(hp[`d${n}Close`]!=null && hp[`d${n}Close`]>0) return hp[`d${n}Close`]; }
    // 종가가 없으면 weekHigh라도
    if(hp.weekHigh) return hp.weekHigh;
    return null;
  }

  let priceMap={};
  try{
    const res=await fetch(API_BASE+`/api/price?codes=${codes.join(',')}`);
    if(res.ok){
      const data=await res.json();
      (data.items||[]).forEach(x=>{ if(x.currentPrice!=null) priceMap[String(x.code)]=x.currentPrice; });
    }
  }catch(e){}

  let changed=false;
  myRecords.forEach(r=>{
    const code=r.code; if(!code) return;
    // prices_latest 우선, 없으면 history_prices 폴백
    let cur = priceMap[String(code)];
    if(cur==null) cur=fromHistory(code);
    if(cur!=null && r.currentPrice!==cur){ r.currentPrice=cur; changed=true; }
  });
  if(changed){ saveMyRecords(); if(currentTab==='mypage') renderMyPage(); }
}

function _renderRecordList(){
  if(!myRecords.length) return `<div style="padding:36px;text-align:center;color:var(--text3);font-size:13.5px">아직 청약 기록이 없습니다.<br><span style="font-size:12px;margin-top:6px;display:block">"+ 청약 기록 추가"로 직접 참여한 공모주를 입력해보세요.</span></div>`;
  const sorted=[...myRecords].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const money=(v,withSign=true)=>`${withSign&&v>=0?'+':''}${v.toLocaleString()}원`;
  const colored=(v)=>`<span style="color:${v>=0?'var(--gain)':'var(--loss)'};font-weight:700">${money(v)}</span>`;
  return `<div class="myrec-table">
    <div class="myrec-head"><div>종목명</div><div>청약일</div><div>배정</div><div>매도손익</div><div>보유손익</div><div>총 손익</div><div></div></div>
    ${sorted.map(r=>{
      const b=_recordBreakdown(r);
      // 매도손익: 매도분이 있고 매도가 입력됐을 때
      const hasSold = b.sold>0 && r.sellPrice!=null && r.ipoPrice!=null;
      const soldStr = hasSold
        ? `${colored(b.realized)}<span class="myrec-sub">매도 ${b.sold}주</span>`
        : (b.sold>0?'<span style="color:var(--text3)">매도가 미입력</span>':'<span style="color:var(--text3)">—</span>');
      // 보유손익: 보유분이 있고 현재가가 있을 때
      const hasHeld = b.held>0;
      const heldStr = !hasHeld ? '<span style="color:var(--text3)">—</span>'
        : (r.currentPrice!=null
            ? `${colored(b.unrealized)}<span class="myrec-sub">보유 ${b.held}주 · 평가 ${b.heldValue.toLocaleString()}원</span>`
            : `<span style="color:var(--text3)">보유 ${b.held}주</span><span class="myrec-sub">시세 동기화 필요</span>`);
      // 총 손익
      const hasAny = hasSold || (hasHeld && r.currentPrice!=null);
      const totalStr = hasAny ? colored(b.total) : '<span style="color:var(--text3)">—</span>';
      return `<div class="myrec-row">
        <div style="font-weight:700">${r.name}<span class="myrec-sub" style="font-weight:500">${r.ipoPrice!=null?'공모 '+r.ipoPrice.toLocaleString():''}</span></div>
        <div style="font-size:13px;color:var(--text2)">${r.date||'—'}</div>
        <div style="font-size:13px">${b.alloc>0?b.alloc+'주':'—'}</div>
        <div style="font-size:13px">${soldStr}</div>
        <div style="font-size:13px">${heldStr}</div>
        <div style="font-size:14px">${totalStr}</div>
        <div style="display:flex;gap:4px;justify-content:flex-end">
          <button class="myrec-icon-btn" onclick="openRecordForm('${r.id}')" title="수정">✎</button>
          <button class="myrec-icon-btn del" onclick="deleteRecord('${r.id}')" title="삭제">✕</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// 청약 기록 추가/수정 폼 (모달 재사용)
function openRecordForm(id){
  const r = id ? myRecords.find(x=>x.id===id) : null;
  // 지난청약(상장완료+상장예정) 종목을 버튼으로 나열
  const pastIpos=IPOS.filter(i=>{const s=calcStatus(i);return s==='past'||s==='listed';})
    .sort((a,b)=>(b.subscribeStart||'').localeCompare(a.subscribeStart||''));
  const pickButtons = pastIpos.length
    ? `<div class="rec-pick-grid">${pastIpos.map(i=>`<button type="button" class="rec-pick-btn" onclick="pickRecordIpo('${i.id}')">${i.name}<span>${i.subscribeStart?fmtDate(i.subscribeStart):''}</span></button>`).join('')}</div>`
    : '<div style="font-size:12.5px;color:var(--text3);padding:8px">선택할 지난 청약 종목이 없습니다. 아래에 직접 입력하세요.</div>';

  el('modal-name').textContent = r ? '청약 기록 수정' : '청약 기록 추가';
  el('modal-sub').textContent = '직접 참여한 공모주 정보를 입력하세요';
  el('modal-body').innerHTML=`
    <div style="display:flex;flex-direction:column;gap:14px">
      ${!r?`<div class="myrec-field"><label>종목 선택 (지난 청약)</label>${pickButtons}</div>`:''}
      <div class="myrec-field"><label>종목명 *</label><input id="rec-name" value="${r?_esc(r.name):''}" placeholder="버튼으로 선택하거나 직접 입력"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="myrec-field"><label>청약일</label><input id="rec-date" type="date" value="${r?.date||''}"></div>
        <div class="myrec-field"><label>공모가 (원)</label><input id="rec-price" type="number" min="0" value="${r?.ipoPrice??''}" placeholder="예: 14800"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div class="myrec-field"><label>배정 수량</label><input id="rec-alloc" type="number" min="0" value="${r?.allocated??''}" placeholder="주" oninput="updateRecordPreview()"></div>
        <div class="myrec-field"><label>매도 수량</label><input id="rec-sold" type="number" min="0" value="${r?.soldShares??''}" placeholder="주" oninput="updateRecordPreview()"></div>
        <div class="myrec-field"><label>매도 단가</label><input id="rec-sell" type="number" min="0" value="${r?.sellPrice??''}" placeholder="원" oninput="updateRecordPreview()"></div>
      </div>
      <input type="hidden" id="rec-code" value="${r?_esc(r.code||''):''}">
      <div class="myrec-field"><label>메모 (선택)</label><input id="rec-memo" type="text" value="${r?_esc(r.memo||''):''}" placeholder="예: 균등 1주 배정"></div>
      <div id="rec-preview" class="myrec-preview"></div>
    </div>`;
  el('modal-foot').innerHTML=`
    ${r?`<button class="btn btn-danger" onclick="deleteRecord('${r.id}')">삭제</button>`:''}
    <button class="btn btn-ghost" onclick="closeModal()">취소</button>
    <button class="btn btn-navy" onclick="saveRecord('${r?r.id:''}')">저장</button>`;
  el('ipo-modal').classList.add('show');
  updateRecordPreview();
}
window.openRecordForm=openRecordForm;

// 지난청약 버튼 선택 → 종목명·청약일·공모가·코드 자동 입력
function pickRecordIpo(id){
  const ipo=IPOS.find(i=>String(i.id)===String(id)); if(!ipo) return;
  el('rec-name').value=ipo.name;
  el('rec-date').value=ipo.subscribeStart||'';
  el('rec-price').value=ipo.finalPrice||ipo.priceRange?.[1]||'';
  el('rec-code').value=ipo.code||'';
  // 선택된 버튼 강조
  qsa('.rec-pick-btn').forEach(b=>b.classList.remove('on'));
  if(event&&event.target) (event.target.closest('.rec-pick-btn'))?.classList.add('on');
  updateRecordPreview();
}
window.pickRecordIpo=pickRecordIpo;

function updateRecordPreview(){
  const box=el('rec-preview'); if(!box) return;
  const alloc=Number(el('rec-alloc')?.value)||0;
  const sold=Math.min(Number(el('rec-sold')?.value)||0, alloc);
  const held=Math.max(alloc-sold,0);
  const price=Number(el('rec-price')?.value)||0;
  const sell=Number(el('rec-sell')?.value)||0;
  if(alloc&&price&&(sold&&sell)){
    const realized=Math.round((sell-price)*sold);
    box.innerHTML=`매도 ${sold}주 실현손익: <strong style="color:${realized>=0?'var(--gain)':'var(--loss)'}">${realized>=0?'+':''}${realized.toLocaleString()}원</strong>${held>0?` · 보유 ${held}주 (현재가는 시세 동기화 후 반영)`:''}`;
    box.style.display='block';
  } else if(alloc&&held>0){
    box.innerHTML=`보유 ${held}주 · 매도분 입력 시 손익이 계산됩니다.`;
    box.style.display='block';
  } else { box.style.display='none'; }
}
window.updateRecordPreview=updateRecordPreview;

function saveRecord(id){
  const name=el('rec-name').value.trim();
  if(!name){ notify('종목명을 입력해주세요.','err'); return; }
  const prev = id ? myRecords.find(x=>x.id===id) : null;
  const rec={
    id: id||('rec_'+Date.now()),
    name,
    code: el('rec-code').value.trim()|| (IPOS.find(i=>i.name===name)?.code) ||null,
    date: el('rec-date').value||null,
    allocated: el('rec-alloc').value!==''?Number(el('rec-alloc').value):null,
    soldShares: el('rec-sold').value!==''?Number(el('rec-sold').value):0,
    ipoPrice: el('rec-price').value!==''?Number(el('rec-price').value):null,
    sellPrice: el('rec-sell').value!==''?Number(el('rec-sell').value):null,
    currentPrice: prev?prev.currentPrice:null, // 시세 동기화로 채워진 값 보존
    memo: el('rec-memo').value.trim()||null,
  };
  if(id){ const idx=myRecords.findIndex(x=>x.id===id); if(idx>=0) myRecords[idx]=rec; else myRecords.push(rec); }
  else myRecords.push(rec);
  saveMyRecords(); closeModal(); renderMyPage(); notify('청약 기록이 저장되었습니다.','ok');
}
window.saveRecord=saveRecord;

function deleteRecord(id){
  if(!confirm('이 청약 기록을 삭제할까요?')) return;
  myRecords=myRecords.filter(x=>x.id!==id);
  saveMyRecords(); closeModal(); renderMyPage(); notify('삭제되었습니다.','ok');
}
window.deleteRecord=deleteRecord;

// 보유 중 종목 상세 모달 (이름 + 보유수량 + 현재가 + 평가액)
function showHoldings(){
  const holdings=myRecords.map(r=>({r, b:_recordBreakdown(r)})).filter(x=>x.b.held>0);
  el('modal-name').textContent='보유 중인 공모주';
  el('modal-sub').textContent=`${holdings.length}개 종목`;
  el('modal-body').innerHTML=`
    <div class="holding-list">
      ${holdings.map(({r,b})=>{
        const cur=r.currentPrice!=null?r.currentPrice:null;
        const valuation=cur!=null?cur*b.held:null;
        const plus=b.unrealized;
        return `<div class="holding-item">
          <div class="holding-main">
            <div class="holding-name">${r.name}</div>
            <div class="holding-qty">${b.held}주 보유</div>
          </div>
          <div class="holding-prices">
            <div class="holding-row"><span>공모가</span><span>${r.ipoPrice!=null?r.ipoPrice.toLocaleString()+'원':'—'}</span></div>
            <div class="holding-row"><span>현재가${priceInfoTip({code:r.code})}</span><span>${cur!=null?cur.toLocaleString()+'원':'<em style="color:var(--text3);font-style:normal">시세 동기화 필요</em>'}</span></div>
            <div class="holding-row strong"><span>평가액</span><span>${valuation!=null?valuation.toLocaleString()+'원':'—'}</span></div>
            ${cur!=null?`<div class="holding-row"><span>평가손익</span><span style="color:${plus>=0?'var(--gain)':'var(--loss)'};font-weight:700">${plus>=0?'+':''}${plus.toLocaleString()}원</span></div>`:''}
          </div>
        </div>`;
      }).join('')||'<div style="padding:24px;text-align:center;color:var(--text3)">보유 중인 종목이 없습니다.</div>'}
    </div>
    <div style="font-size:11.5px;color:var(--text3);margin-top:14px;line-height:1.5">※ 현재가는 매일 저녁 9시 시세 기준입니다. 관리자 페이지에서 "시세 동기화"를 실행하면 최신화됩니다.</div>`;
  el('modal-foot').innerHTML=`<button class="btn btn-ghost" onclick="closeModal()">닫기</button>`;
  el('ipo-modal').classList.add('show');
}
window.showHoldings=showHoldings;

function _esc(s){ return String(s||'').replace(/"/g,'&quot;'); }
function _renderWatchlistCards(wi){
  if(!wi.length) return `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">관심 종목이 없습니다.<br><span style="font-size:12px;margin-top:6px;display:block">종목 상세보기에서 ⭐를 눌러 추가하세요.</span></div>`;
  function getDday(ipo){ const s=calcStatus(ipo); if(s==='active') return 'D-Day'; const start=ipo.subscribeStart?new Date(ipo.subscribeStart+'T00:00:00'):null; if(start){ const diff=Math.ceil((start-TODAY)/86400000); return diff>0?`D-${diff}`:diff===0?'D-Day':''; } return ''; }
  return `<div class="mypage-wl-grid">${wi.map(i=>`
    <div class="mypage-wl-card" onclick="openModal('${i.id}')">
      <div class="mypage-wl-card-name">${i.name}</div>
      <div class="mypage-wl-card-sector">${i.sector||'—'}</div>
      <div class="mypage-wl-card-row"><span>청약일</span><span>${i.subscribeStart?i.subscribeStart.slice(5)+' ~':'—'}</span></div>
      <div class="mypage-wl-card-row"><span>공모가</span><span>${i.finalPrice?i.finalPrice.toLocaleString()+'원':i.priceRange?.[1]?i.priceRange[1].toLocaleString()+'원':'—'}</span></div>
      <div class="mypage-wl-card-row"><span>경쟁률</span><span>${i.competitionRate?i.competitionRate.toLocaleString()+':1':'—'}</span></div>
      ${getDday(i)?`<span class="mypage-wl-card-dday">${getDday(i)}</span>`:''}
      <button class="mypage-wl-card-remove" onclick="event.stopPropagation();toggleWl('${i.id}')">✕</button>
    </div>`).join('')}</div>`;
}

// ─────────────────────────────────────────────────────────────
// 청약 루트 플래너
// ─────────────────────────────────────────────────────────────
let plannerState={ asset:0, pickedId:null, userRate:null };

function formatPlannerAsset(inp){
  const num=Number(inp.value.replace(/[^0-9]/g,''))||0;
  plannerState.asset=num;
  inp.value=num?num.toLocaleString('ko-KR'):'';
  recalcEqualPlan();
}
function setPlannerAsset(n){
  plannerState.asset=n;
  const inp=el('planner-asset'); if(inp) inp.value=n.toLocaleString('ko-KR');
  recalcEqualPlan();
}
// 사용자가 직접 입력한 예상 경쟁률 (비우면 자동 추정값 사용)
function setPlannerRate(inp){
  const v=Number(inp.value.replace(/[^0-9.]/g,''));
  plannerState.userRate=(v>0)?v:null;
  recalcEqualPlan();
}
function clearPlannerRate(){
  plannerState.userRate=null;
  if(window.renderPlanner) renderPlanner(); else recalcEqualPlan();
}
window.setPlannerRate=setPlannerRate;
window.clearPlannerRate=clearPlannerRate;
window.formatPlannerAsset=formatPlannerAsset;
window.setPlannerAsset=setPlannerAsset;

// 날짜 헬퍼
function _pDate(s){ return s?new Date(s+'T00:00:00'):null; }
function _addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function _fmtKDate(d){ if(!d) return '미정'; return `${d.getMonth()+1}월 ${d.getDate()}일`; }
function _fmtKDateW(d){ if(!d) return '미정'; const w=['일','월','화','수','목','금','토'][d.getDay()]; return `${d.getMonth()+1}/${d.getDate()}(${w})`; }
// 환불일: 입력값 있으면 당일, 없으면 청약마감일 +2일
function _refundDate(ipo){
  if(ipo.refundDate) return _pDate(ipo.refundDate);
  const end=_pDate(ipo.subscribeEnd)||_pDate(ipo.subscribeStart);
  return end?_addDays(end,2):null;
}
// 종목 1건 최소 청약 증거금
// 기준 공식 = 공모가 상단 × 최소청약수량(10주) × 증거금률(50%).
// admin에 저장된 minDeposit이 공식값과 크게 어긋나면(잘못 입력) 공식값으로 자동 보정.
function _minDeposit(ipo){
  const price=ipo.finalPrice||ipo.priceRange?.[1]||0;
  const formula=price?Math.round(price*10*0.5):0;
  const saved=Number(ipo.minDeposit)||0;
  if(!formula) return saved||0;
  if(!saved) return formula;
  // 저장값이 공식값의 80~125% 범위면 신뢰(종목별 최소수량 차이 허용), 아니면 공식값으로 보정
  if(saved>=formula*0.8 && saved<=formula*1.25) return saved;
  return formula;
}

// 청약 대상 종목 (청약중+예정, 청약시작일 순)
function _plannerPool(){
  return IPOS.filter(i=>{const s=calcStatus(i);return s==='active'||s==='upcoming';})
    .filter(i=>i.subscribeStart && _minDeposit(i)>0)
    .sort((a,b)=>(a.subscribeStart||'').localeCompare(b.subscribeStart||''));
}

// ── 균등 배정 시뮬레이션 (날짜별 자금 흐름) ──
// 모든 종목에 "최소 증거금"으로 청약한다고 가정.
// 자금 부족하면 그 종목은 청약 불가(skip).
// 날짜별 이벤트: 청약(−증거금), 환불(+증거금)
function _buildEqualTimeline(asset, customPool){
  const pool=customPool||_plannerPool();
  // 1) 각 종목 청약 가능 여부를 시간순으로 판정하며 잔액 추적
  let balance=asset;
  const locked=[];        // {refundDate, amount, ipo}
  const decided=[];       // {ipo, dep, ok}
  // 청약 시작일 순으로 처리
  for(const ipo of pool){
    const subStart=_pDate(ipo.subscribeStart);
    // 청약 시작 전 환불 회수
    for(let k=locked.length-1;k>=0;k--){
      if(locked[k].refundDate && subStart && locked[k].refundDate<=subStart){
        balance+=locked[k].amount; locked.splice(k,1);
      }
    }
    const dep=_minDeposit(ipo);
    const ok = dep<=balance;
    if(ok){ balance-=dep; locked.push({refundDate:_refundDate(ipo), amount:dep, ipo}); }
    decided.push({ipo, dep, ok});
  }

  // 2) 날짜별 이벤트 생성
  const evMap={}; // 'YYYY-MM-DD' → {date, subs:[], refunds:[], shorts:[]}
  function ensure(d){ const k=`${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; if(!evMap[k]) evMap[k]={date:new Date(d),subs:[],refunds:[],shorts:[]}; return evMap[k]; }
  decided.filter(x=>x.ok).forEach(({ipo,dep})=>{
    const ss=_pDate(ipo.subscribeStart); if(ss) ensure(ss).subs.push({ipo,dep});
    const rd=_refundDate(ipo); if(rd) ensure(rd).refunds.push({ipo,dep,estimated:!ipo.refundDate});
  });
  // 자금 부족으로 청약 못한 종목도 청약일에 표시
  decided.filter(x=>!x.ok).forEach(({ipo,dep})=>{
    const ss=_pDate(ipo.subscribeStart); if(ss) ensure(ss).shorts.push({ipo,dep});
  });

  // 3) 날짜순 정렬 후 잔액 흐름 계산
  const days=Object.values(evMap).sort((a,b)=>a.date-b.date);
  let bal=asset;
  let lockedRun=0;
  const timeline=days.map(day=>{
    const subTotal=day.subs.reduce((s,x)=>s+x.dep,0);
    const refundTotal=day.refunds.reduce((s,x)=>s+x.dep,0);
    const balBefore=bal;
    bal+=refundTotal;       // 환불 입금
    const afterRefund=bal;
    bal-=subTotal;          // 청약 증거금 출금
    const afterSub=bal;
    lockedRun += subTotal - refundTotal; // 그날 끝 시점 누적 묶임액
    if(lockedRun<0) lockedRun=0;
    return { date:day.date, subs:day.subs, refunds:day.refunds, shorts:day.shorts, subTotal, refundTotal, balBefore, afterRefund, afterSub, lockedNow:lockedRun };
  });

  const joined=decided.filter(x=>x.ok);
  const skipped=decided.filter(x=>!x.ok);
  const totalMinNeeded=decided.reduce((s,x)=>s+x.dep,0); // 전 종목 동시 청약 시 필요액(참고)
  // 최대 동시 묶임(피크) — 자산값과 무관하게 0 기준으로 누적해 계산
  const ev2=[];
  joined.forEach(({ipo,dep})=>{ const ss=_pDate(ipo.subscribeStart),rd=_refundDate(ipo); if(ss)ev2.push({t:ss,a:dep}); if(rd)ev2.push({t:rd,a:-dep}); });
  ev2.sort((a,b)=>a.t-b.t||a.a-b.a); // 같은 날은 환불(-) 먼저 처리해 회전 반영
  let curLocked=0, peakLocked=0;
  ev2.forEach(e=>{ curLocked+=e.a; if(curLocked>peakLocked)peakLocked=curLocked; });

  return { timeline, joined, skipped, asset, peakLocked, finalBal:bal, totalMinNeeded };
}

// 직전 공모주(상장완료) 결과로 평균 수요예측 경쟁률 추정
function _avgCompetition(){
  const past=IPOS.filter(i=>calcStatus(i)==='listed' && i.competitionRate>0 && !i.isSpac);
  if(!past.length) return 1500;
  return Math.round(past.reduce((s,i)=>s+i.competitionRate,0)/past.length);
}
// 같은 섹터 상장완료 종목들의 평균 경쟁률 (없으면 null)
function _sectorAvgCompetition(sector){
  if(!sector) return null;
  const same=IPOS.filter(i=>calcStatus(i)==='listed' && i.competitionRate>0 && !i.isSpac && i.sector===sector);
  if(!same.length) return null;
  return { rate:Math.round(same.reduce((s,i)=>s+i.competitionRate,0)/same.length), count:same.length, names:same.map(i=>i.name) };
}
// 종목의 청약 경쟁률 예측
//  1) 확정 경쟁률 있으면 사용
//  2) 같은 섹터 상장완료 종목이 있으면 섹터 평균
//  3) 없으면 전체 평균
function _estCompetition(ipo){
  if(ipo.competitionRate>0) return { rate:ipo.competitionRate, basis:'fixed' };
  const sec=_sectorAvgCompetition(ipo.sector);
  if(sec) return { rate:sec.rate, basis:'sector', sectorInfo:sec };
  return { rate:_avgCompetition(), basis:'avg' };
}
// 균등/비례 예상 배정 수량 계산
function _estimateAllocation(ipo, money, userRate){
  const price=ipo.finalPrice||ipo.priceRange?.[1]||0;
  if(!price) return null;
  // 경쟁률: 사용자 입력 > 자동 추정
  let est, rate;
  if(userRate&&userRate>0){ est={ basis:'user' }; rate=userRate; }
  else { est=_estCompetition(ipo); rate=est.rate; }
  const MIN_UNIT=10;
  // money가 있으면 그 금액 기준, 없으면 최소청약(10주) 기준
  const applyShares = (money&&money>0) ? Math.floor((money/0.5)/price) : MIN_UNIT;
  const minDeposit=_minDeposit(ipo);
  if(applyShares<=0) return { price, rate, est, applyShares:0, minDeposit, equalPerPerson:0, equalWhole:0, equalProb:0, propShares:0, propWhole:0, propFrac:0 };
  const propSharesRaw=applyShares/rate;
  // 균등 배정: 경쟁률 구간별 1인당 예상 배정주(소수 가능)
  let equalPerPerson;
  if(rate>=2500) equalPerPerson=0.5;
  else if(rate>=1500) equalPerPerson=1;
  else if(rate>=800) equalPerPerson=1.5;
  else equalPerPerson=2;
  const equalWhole=Math.floor(equalPerPerson);
  const equalProb=Math.round((equalPerPerson-equalWhole)*100);
  const propShares=Math.round(propSharesRaw*10)/10;
  const propWhole=Math.floor(propSharesRaw);
  const propFrac=Math.round((propSharesRaw-propWhole)*10)/10;
  return {
    price, rate, est, applyShares, minDeposit,
    equalPerPerson, equalWhole, equalProb,
    propShares, propWhole, propFrac, propSharesRaw,
  };
}

function renderPlanner(){
  const pool=_plannerPool();
  if(!plannerState.pickedId && pool.length) plannerState.pickedId=String(pool[0].id);
  const picked=pool.find(i=>String(i.id)===String(plannerState.pickedId));

  // 선택 종목 자동 정보 (공모가 / 최소증거금 / 배정수 / 예상경쟁률)
  let autoBox='';
  if(picked){
    const a=_estimateAllocation(picked, plannerState.asset, plannerState.userRate);
    const price=picked.finalPrice||picked.priceRange?.[1]||0;
    const est=picked && _estCompetition(picked);
    let rateNote;
    if(plannerState.userRate) rateNote='<b>직접 입력</b>한 경쟁률입니다.';
    else if(est.basis==='fixed') rateNote='이 종목의 <b>확정 경쟁률</b>입니다.';
    else if(est.basis==='sector') rateNote=`같은 섹터(${picked.sector}) 직전 상장 평균입니다.`;
    else rateNote='전체 상장 종목 평균입니다.';
    const shownRate=plannerState.userRate||(a?a.rate:0);
    const eqStr = a ? (a.equalWhole + (a.equalProb>0?('.'+String(a.equalProb).padStart(2,'0').slice(0,1)):'')) : '-';
    autoBox = a ? `
      <div class="planner-auto">
        <div class="pa-row"><span class="pa-l">공모가</span><span class="pa-v">${price?price.toLocaleString('ko-KR')+'원':'미정'}</span></div>
        <div class="pa-row"><span class="pa-l">최소 증거금 <span class="pa-sub">(10주 · 증거금률 50%)</span></span><span class="pa-v">${a.minDeposit.toLocaleString('ko-KR')}원</span></div>
        <div class="pa-row"><span class="pa-l">예상 배정 수</span><span class="pa-v">균등 ${a.equalPerPerson} <span style="color:var(--text3)">:</span> 비례 ${a.propShares}</span></div>
        <div class="pa-row pa-rate">
          <span class="pa-l">예상 경쟁률</span>
          <span class="pa-rate-input"><input type="text" id="planner-rate" inputmode="decimal" value="${shownRate?Math.round(shownRate).toLocaleString('ko-KR'):''}" oninput="setPlannerRate(this)"><span>: 1</span></span>
        </div>
        <div class="pa-note">${rateNote} 직접 수정할 수 있습니다.${plannerState.userRate?` <button class="planner-rate-clear" onclick="clearPlannerRate()">↺ 자동값으로</button>`:''}</div>
      </div>` : '<div class="planner-empty">공모가 정보가 없어 계산할 수 없습니다.</div>';
  }

  el('planner-content').innerHTML=`
    <div class="alloc-calc-grid">
      <div class="planner-card">
        <div class="planner-step">
          <div class="planner-step-head"><span class="planner-step-num">1</span><span class="planner-step-title">공모주 선택</span></div>
          <div class="alloc-pick-grid" id="alloc-pick">
            ${pool.map(i=>`<button class="alloc-pick-btn ${String(plannerState.pickedId)===String(i.id)?'on':''}" onclick="pickAllocIpo('${i.id}')">${i.name}</button>`).join('')||'<span style="color:var(--text3);font-size:13px">청약 가능한 종목이 없습니다.</span>'}
          </div>
          <div style="margin:16px 0 4px;font-size:13px;font-weight:700;color:var(--text2)">투자 가능 증거금 <span style="font-weight:400;color:var(--text3);font-size:12px">(선택 — 비례 배정 계산)</span></div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <input id="planner-asset" type="text" inputmode="numeric" placeholder="예: 1,000,000" value="${plannerState.asset?plannerState.asset.toLocaleString('ko-KR'):''}" oninput="formatPlannerAsset(this)" style="flex:1;min-width:0;padding:11px 13px;border:1.5px solid var(--border);border-radius:10px;font-size:15px;font-variant-numeric:tabular-nums">
            <span style="font-size:14px;color:var(--text3);font-weight:600">원</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
            ${[['50만',500000],['100만',1000000],['300만',3000000],['500만',5000000],['1,000만',10000000]].map(q=>`<button type="button" onclick="setPlannerAsset(${q[1]})" style="padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--panel);font-size:12px;font-weight:600;color:var(--text2);cursor:pointer">${q[0]}</button>`).join('')}
          </div>
          <div style="font-size:11.5px;color:var(--text3);margin-bottom:2px">증거금률 50% 기준으로 신청 가능 주수를 계산합니다. 비워두면 최소청약(10주) 기준.</div>
          ${autoBox}
        </div>
      </div>
      <div id="planner-alloc"></div>
    </div>`;
  recalcEqualPlan();
}
window.renderPlanner=renderPlanner;

function pickAllocIpo(id){
  if(String(plannerState.pickedId)!==String(id)) plannerState.userRate=null; // 새 종목은 자동값 사용
  plannerState.pickedId=String(id);
  renderPlanner();
}
window.pickAllocIpo=pickAllocIpo;

// ─────────────────────────────────────────────────────────────
// 균등 예산 최적화 — 종목 선택 → 필요 최소 금액 + 날짜별 타임라인
// ─────────────────────────────────────────────────────────────
const ROUTE_FEE=2000; // 타사 청약 당첨 수수료(대표 가정)

let routeState={ picked:{}, asset:0, initialized:false, recommended:{} }; // { ipoId: true }

function toggleRoutePick(id){
  id=String(id);
  if(routeState.picked[id]) delete routeState.picked[id];
  else routeState.picked[id]=true;
  renderRoute();
}
function routePickAll(on){
  routeState.picked={};
  if(on) _plannerPool().forEach(i=>routeState.picked[String(i.id)]=true);
  routeState.initialized=true;
  renderRoute();
}
function formatRouteAsset(inp){
  const n=Number(String(inp.value||'').replace(/[^0-9]/g,''));
  routeState.asset=n||0;
  inp.value=n?n.toLocaleString('ko-KR'):'';
  recalcRoute();
}
function setRouteAsset(n){
  routeState.asset=n||0;
  const inp=el('route-asset'); if(inp) inp.value=routeState.asset?routeState.asset.toLocaleString('ko-KR'):'';
  recalcRoute();
}
function applyRouteRecommendation(){
  routeState.picked={...routeState.recommended};
  routeState.initialized=true;
  renderRoute();
  notify('추천 조합을 선택했습니다.','ok');
}
window.toggleRoutePick=toggleRoutePick;
window.routePickAll=routePickAll;
window.formatRouteAsset=formatRouteAsset;
window.setRouteAsset=setRouteAsset;
window.applyRouteRecommendation=applyRouteRecommendation;

function _routeFmtDate(d){ return `${d.getMonth()+1}월 ${d.getDate()}일`; }
function _routeCost(ipo){
  const dep=_minDeposit(ipo);
  const price=ipo.finalPrice||ipo.priceRange?.[1]||0;
  const fee=price>0?ROUTE_FEE:0;
  return { dep, price, fee, refundWin:Math.max(0,dep-price-fee), refundLose:dep };
}
function _routePlanForPool(pool, asset){
  const evs=[];
  const evMap={};
  function ensure(d){ const k=d.toISOString().slice(0,10); if(!evMap[k]) evMap[k]={date:new Date(d),subs:[],refunds:[]}; return evMap[k]; }
  pool.forEach(ipo=>{
    const c=_routeCost(ipo);
    const ss=_pDate(ipo.subscribeStart);
    const rd=_refundDate(ipo);
    if(ss){ evs.push({date:ss, type:'sub', amount:c.dep, ipo, cost:c}); ensure(ss).subs.push({ipo,...c}); }
    if(rd){ evs.push({date:rd, type:'refund', amount:c.refundWin, ipo, cost:c, estimated:!ipo.refundDate}); ensure(rd).refunds.push({ipo,...c,estimated:!ipo.refundDate}); }
  });
  evs.sort((a,b)=>a.date-b.date||(a.type==='refund'?-1:1));
  let net=0, minNet=0;
  evs.forEach(e=>{ net += e.type==='refund'?e.amount:-e.amount; if(net<minNet) minNet=net; });
  const needed=-minNet;

  let bal=asset||0;
  const days=Object.values(evMap).sort((a,b)=>a.date-b.date).map(day=>{
    const balBefore=bal;
    const refundTotal=day.refunds.reduce((s,x)=>s+x.refundWin,0);
    bal+=refundTotal;
    const afterRefund=bal;
    const subTotal=day.subs.reduce((s,x)=>s+x.dep,0);
    bal-=subTotal;
    return { ...day, balBefore, refundTotal, afterRefund, subTotal, afterSub:bal };
  });
  return { needed, days, finalBal:bal, count:pool.length };
}
function _routeRiskSum(pool){ return pool.reduce((s,i)=>s+(riskProfile(i).score??35),0); }
function _routeOptimize(asset, pool){
  if(!asset||asset<=0) return { best:[], neededByCount:{}, bestNeed:_routePlanForPool(pool,0).needed };
  const n=pool.length;
  let best=[], bestNeed=0, bestRisk=Infinity;
  const neededByCount={0:0};
  function consider(list){
    const plan=_routePlanForPool(list,0);
    const count=list.length;
    if(neededByCount[count]==null || plan.needed<neededByCount[count]) neededByCount[count]=plan.needed;
    if(plan.needed>asset) return;
    const risk=_routeRiskSum(list);
    if(count>best.length || (count===best.length && (plan.needed<bestNeed || (plan.needed===bestNeed && risk<bestRisk)))){
      best=list.slice(); bestNeed=plan.needed; bestRisk=risk;
    }
  }
  if(n<=18){
    const walk=(idx, list)=>{
      if(idx===n){ consider(list); return; }
      walk(idx+1,list);
      list.push(pool[idx]); walk(idx+1,list); list.pop();
    };
    walk(0,[]);
  } else {
    const sorted=pool.slice().sort((a,b)=>_minDeposit(a)-_minDeposit(b)||(a.subscribeStart||'').localeCompare(b.subscribeStart||''));
    let cur=[];
    sorted.forEach(i=>{ const next=cur.concat(i); if(_routePlanForPool(next,0).needed<=asset) cur=next; });
    best=cur; bestNeed=_routePlanForPool(best,0).needed;
    for(let c=0;c<=best.length;c++) neededByCount[c]=c===best.length?bestNeed:0;
  }
  return { best, neededByCount, bestNeed };
}

function renderRoute(){
  const box=el('route-content'); if(!box) return;
  const pool=_plannerPool().slice().sort((a,b)=>(a.subscribeStart||'').localeCompare(b.subscribeStart||''));
  if(!routeState.initialized && pool.length){
    routeState.picked={};
    pool.forEach(i=>routeState.picked[String(i.id)]=true);
    routeState.initialized=true;
  }
  const pickedCount=Object.keys(routeState.picked).length;
  const allOn=pool.length>0 && pickedCount===pool.length;
  const chips=pool.map(i=>{
    const on=!!routeState.picked[String(i.id)];
    return `<button class="route-pick-chip ${on?'on':''}" aria-pressed="${on?'true':'false'}" onclick="toggleRoutePick('${i.id}')">${on?'✓ ':''}${i.name}</button>`;
  }).join('')||'<span style="color:var(--text3);font-size:13px">청약 가능한(청약중·예정) 종목이 없습니다.</span>';
  box.innerHTML=`
    <div class="planner-card">
      <div class="planner-step">
        <div class="planner-step-head"><span class="planner-step-num">1</span><span class="planner-step-title">청약할 공모주 선택</span>
          ${pool.length?`<button class="route-allbtn" onclick="routePickAll(${allOn?'false':'true'})">${allOn?'전체 해제':'전체 선택'}</button>`:''}
        </div>
        <div class="route-pick-grid">${chips}</div>
        <div class="planner-hint">선택한 종목 전체를 최소 청약한다고 가정하고, 환불금 재사용과 1주 배정 시 결제금·수수료까지 반영해 필요한 최소 금액을 계산합니다.</div>
      </div>
    </div>
    <div id="route-result"></div>`;
  recalcRoute();
}
window.renderRoute=renderRoute;

function recalcRoute(){
  const box=el('route-result'); if(!box) return;
  const all=_plannerPool();
  const picked=all.filter(i=>routeState.picked[String(i.id)]);
  if(!all.length){ box.innerHTML='<div class="planner-empty">현재 청약 가능한(청약중·예정) 종목이 없습니다.</div>'; return; }
  if(!picked.length){ box.innerHTML='<div class="planner-empty">위에서 청약할 공모주를 선택하면 날짜별 청약·환불 일정을 정리해 드립니다.</div>'; return; }
  const selectedNeed=_routePlanForPool(picked,0).needed;
  const selectedPlan=_routePlanForPool(picked,selectedNeed);
  const allPlan=_routePlanForPool(all,0);
  routeState.recommended={};
  picked.forEach(i=>routeState.recommended[String(i.id)]=true);
  const summary=`선택한 ${picked.length}개 균등 참여에 필요한 최소 금액`;
  const sub=`환불금 재사용 · 1주 배정 + 수수료 ${ROUTE_FEE.toLocaleString('ko-KR')}원 차감 기준`;

  const cards=all.map(ipo=>{
    const selected=!!routeState.picked[String(ipo.id)];
    const c=_routeCost(ipo);
    const cls=selected?'ok':'skip';
    const flag=selected?'선택됨':'제외';
    return `<div class="route-card ${cls}">
      <div class="route-card-top">
        <div class="route-card-name">${h(ipo.name)}</div>
        <span class="route-card-flag ${cls}">${flag}</span>
      </div>
      <div class="route-card-rows">
        <div class="rcr"><span class="rk">청약일</span><strong>${fmtDate(ipo.subscribeStart)}</strong></div>
        <div class="rcr"><span class="rk">환불일</span><strong>${_fmtKDate(_refundDate(ipo))}</strong></div>
        <div class="rcr"><span class="rk">증거금</span><strong>${c.dep.toLocaleString('ko-KR')}원</strong></div>
        <div class="rcr"><span class="rk">성공시 소모</span><strong>${(c.price+c.fee).toLocaleString('ko-KR')}원</strong><em>1주+수수료</em></div>
        <div class="rcr"><span class="rk">실패시 소모</span><strong>0원</strong><em>증거금 전액 환불</em></div>
      </div>
      <div>${riskBadgeGroup(ipo,true)}</div>
    </div>`;
  }).join('');

  const blocks=selectedPlan.days.map(day=>{
    const lines=[];
    day.subs.forEach(x=>{
      lines.push(`<div class="rt-line sub"><span class="rt-ico">📝</span><div><b>${x.ipo.name}</b> 청약<span class="rt-sub">최소 증거금 ${x.dep.toLocaleString()}원</span></div></div>`);
    });
    day.refunds.forEach(x=>{
      lines.push(`<div class="rt-line refund"><span class="rt-ico">💸</span><div><b>${x.ipo.name}</b> 환불${x.estimated?' <em>(예상일)</em>':''}`
        +`<div class="rt-refund">`
          +`<div class="rt-rf-row"><span>청약 성공 시 환불</span><b>${x.refundWin.toLocaleString()}원</b></div>`
          +`<div class="rt-rf-row"><span>청약 실패 시 환불</span><b>${x.refundLose.toLocaleString()}원</b></div>`
          +`<div class="rt-rf-note">＊성공 시 1주 결제대금 ${x.price.toLocaleString()}원 + 수수료 ${x.fee.toLocaleString()}원 소모</div>`
        +`</div></div></div>`);
    });
    lines.push(`<div class="rt-balance">보유 ${day.balBefore.toLocaleString('ko-KR')}원 → 환불 후 ${day.afterRefund.toLocaleString('ko-KR')}원 → 일 종료 <b class="${day.afterSub<0?'neg':''}">${day.afterSub.toLocaleString('ko-KR')}원</b></div>`);
    return `<div class="rt-day"><div class="rt-date">${_routeFmtDate(day.date)}</div><div class="rt-events">${lines.join('')}</div></div>`;
  }).join('');

  box.innerHTML=`
    <div class="route-need">
      <div class="route-need-label">${summary}</div>
      <div class="route-need-amount">${selectedNeed.toLocaleString('ko-KR')}원</div>
      <div class="route-need-sub">${sub}</div>
    </div>
    <div class="route-budget-summary">
      <div class="rbs"><div class="l">선택 종목</div><div class="v">${picked.length}개</div></div>
      <div class="rbs"><div class="l">전체 참여 필요 금액</div><div class="v">${allPlan.needed.toLocaleString('ko-KR')}원</div></div>
      <div class="rbs"><div class="l">일정 종료 예상 잔액</div><div class="v">${selectedPlan.finalBal.toLocaleString('ko-KR')}원</div></div>
    </div>
    <div class="route-section">
      <div class="route-section-title">선택 종목별 자금 소모</div>
      <div class="route-cards-grid">${cards}</div>
    </div>
    <div class="route-section">
      <div class="route-section-title">청약 · 환불 일정</div>
      <div class="rt-timeline">${blocks}</div>
    </div>
    <div class="route-note">
      ※ 최소 증거금 = <strong>공모가 상단 × 10주 × 50%</strong> 기준입니다(종목·증권사별로 다를 수 있어 자동 보정 적용).<br>
      ※ 보수적 환불은 <strong>증거금 − 공모가 1주 − 수수료 ${ROUTE_FEE.toLocaleString('ko-KR')}원</strong> 기준입니다. 실제 0주 배정이면 더 많은 금액이 환불됩니다.<br>
      ※ 표시된 필요 금액은 선택 종목을 모두 최소 청약하는 데 필요한 시작 보유금액입니다.
    </div>`;
}
window.recalcRoute=recalcRoute;


function recalcEqualPlan(){
  const box=el('planner-alloc');
  if(!box) return;
  const pool=_plannerPool();
  if(pool.length===0){ box.innerHTML='<div class="planner-empty">현재 청약 가능한(청약중·예정) 종목이 없습니다.</div>'; return; }
  const ipo=pool.find(i=>String(i.id)===String(plannerState.pickedId))||pool[0];
  const a=_estimateAllocation(ipo, plannerState.asset, plannerState.userRate);
  if(!a){ box.innerHTML='<div class="planner-empty">공모가 정보가 없어 계산할 수 없습니다.</div>'; return; }

  // 균등 배정 표현: 1.5 → "1주(확정) + 1주(확률 50%)"
  let equalLines;
  if(a.equalPerPerson<=0){
    equalLines='<div class="ab-big">0주</div><div class="ab-desc">최소 10주 이상 청약해야 균등 자격이 생깁니다.</div>';
  } else {
    const parts=[];
    if(a.equalWhole>0) parts.push('<span class="ab-tag fix">'+a.equalWhole+'주 확정</span>');
    if(a.equalProb>0) parts.push('<span class="ab-tag prob">+1주 확률 '+a.equalProb+'%</span>');
    equalLines='<div class="ab-big">'+a.equalPerPerson+'<small>주</small></div><div class="ab-tags">'+parts.join('')+'</div>'
      +'<div class="ab-desc">청약자 모두에게 똑같이 나눠주는 물량입니다. 소수점 부분은 추첨이라 확률로 표시됩니다.</div>';
  }

  // 비례 배정: 경쟁률 / 1주당 예상 배정금액 / 5사6입
  const onePropAmt=Math.round(a.price*a.propSharesRaw); // 내 신청 기준 비례 평가금액
  let prop56;
  if(a.propFrac>=0.6) prop56='소수점 <b>'+a.propFrac+'</b> → 0.6 이상이라 <b style="color:var(--positive)">1주 추가 가능</b> (약 '+(a.propWhole+1)+'주)';
  else prop56='소수점 <b>'+a.propFrac+'</b> → 0.5 이하라 <b style="color:var(--negative)">버려질 가능성 높음</b> (약 '+a.propWhole+'주)';

  box.innerHTML=`
    <div class="route-section" style="margin-top:4px">
      <div class="route-section-title">${ipo.name} · 예상 배정</div>
      <div class="alloc-5050">
        <div class="alloc-half eq">
          <div class="ab-head">⚖️ 균등 배정 <button class="calc-formula-btn" onclick="showAllocFormula('equal','${h(ipo.id)}')">계산식 보기</button></div>
          ${equalLines}
        </div>
        <div class="alloc-half pr">
          <div class="ab-head">📊 비례 배정 <button class="calc-formula-btn" onclick="showAllocFormula('prop','${h(ipo.id)}')">계산식 보기</button></div>
          <div class="ab-big">${a.propShares}<small>주</small></div>
          <div class="ab-rows">
            <div class="ab-r"><span>예상 비례 경쟁률</span><b>${a.rate.toLocaleString()} : 1</b></div>
            <div class="ab-r"><span>공모가(1주 결제금)</span><b>${a.price.toLocaleString()}원</b></div>
            <div class="ab-r"><span>확정 배정(버림)</span><b>${a.propWhole}주</b></div>
            <div class="ab-r"><span>5사6입 적용 시</span><b>${a.propFrac>=0.6?(a.propWhole+1)+'주':a.propWhole+'주'}</b></div>
          </div>
          <div class="ab-rule">🔢 ${prop56}<br><span class="ab-rule-caveat">단, 모든 종목이 5사6입을 쓰는 건 아니며 단순 버림·추첨 등 종목·증권사마다 다릅니다.</span></div>
        </div>
      </div>
    </div>
    <div class="route-note">
      ※ <strong>예상치입니다.</strong> 실제 배정은 청약 마감 후 확정되는 일반청약 경쟁률·청약자 수에 따라 달라집니다.<br>
      ※ 균등 배정 수는 정확한 청약자 수를 알 수 없어 경쟁률 구간으로 추정합니다. 경쟁률을 직접 입력하면 그 값으로 다시 계산됩니다.
    </div>`;
}

// 배정 계산식 팝업 — 균등/비례 배정이 어떤 식으로 산출되는지 실제 숫자와 함께 표시
function showAllocFormula(type, id){
  const ipo=IPOS.find(i=>String(i.id)===String(id)); if(!ipo) return;
  const a=_estimateAllocation(ipo, plannerState.asset, plannerState.userRate); if(!a) return;
  let title, body;
  if(type==='equal'){
    title='⚖️ 균등 배정 계산식';
    body=`
      <p class="cf-lead">균등 배정은 <b>균등 배정 물량을 청약 건수로 똑같이 나눈</b> 값입니다. 청약 금액과 무관하게 최소 단위(보통 10주)만 청약하면 누구나 동일하게 받습니다.</p>
      <div class="cf-formula">1인당 균등 배정 = 균등 배정 물량 ÷ 균등 청약 건수</div>
      <div class="cf-example">
        <div class="cf-ex-title">📌 간단한 예시</div>
        균등 물량 <b>50만 주</b>를 청약자 <b>50만 명</b>이 나누면 → <b>1인당 1주</b><br>
        청약자가 <b>100만 명</b>으로 늘면 → 1인당 0.5주 = <b>1주를 받을 확률 50%</b> (소수점은 추첨)
      </div>
      <p class="cf-lead" style="margin-top:12px">실제 청약 건수는 마감 전에는 알 수 없으므로, 이 계산기는 <b>수요예측 경쟁률 구간</b>으로 1인당 배정 주수를 추정합니다.</p>
      <table class="cf-table"><tbody>
        <tr><td>경쟁률 2,500:1 이상 (과열)</td><td>0.5주</td></tr>
        <tr><td>1,500 ~ 2,499:1</td><td>1주</td></tr>
        <tr><td>800 ~ 1,499:1</td><td>1.5주</td></tr>
        <tr><td>800:1 미만</td><td>2주</td></tr>
      </tbody></table>
      <div class="cf-apply">적용 · 이 종목 예상 경쟁률 <b>${a.rate.toLocaleString('ko-KR')}:1</b> → 1인당 <b>${a.equalPerPerson}주</b>${a.equalProb>0?`<br>= ${a.equalWhole}주 확정 + 1주(추첨 확률 ${a.equalProb}%)`:''}</div>
      <p class="cf-note">소수점 부분은 추첨이라 확률로 표기합니다. 최소 청약(보통 10주) 미만이면 균등 배정 자격이 없습니다.</p>`;
  } else {
    title='📊 비례 배정 계산식';
    const raw=a.propSharesRaw||0;
    body=`
      <p class="cf-lead">비례 배정은 <b>내가 신청한 주식 수를 비례 경쟁률로 나눈</b> 값입니다. 청약 증거금을 많이 넣어 더 많이 신청할수록 배정량이 늘어납니다.</p>
      <div class="cf-formula">비례 배정 주수 = 신청 주수 ÷ 비례 경쟁률</div>
      <div class="cf-example">
        <div class="cf-ex-title">📌 간단한 예시</div>
        비례 경쟁률 <b>200:1</b> 종목에 <b>1,000주</b> 신청 → 1,000 ÷ 200 = <b>5주 확정</b><br>
        <b>1,250주</b> 신청 → 6.25주 → 소수점 0.25는 버려 <b>6주</b> (단, 0.6 이상이면 5사6입으로 1주 추가)
      </div>
      <table class="cf-table" style="margin-top:12px"><tbody>
        <tr><td>신청 주수</td><td>${a.applyShares.toLocaleString('ko-KR')}주</td></tr>
        <tr><td>예상 비례 경쟁률</td><td>${a.rate.toLocaleString('ko-KR')} : 1</td></tr>
        <tr><td>나눈 값(원시)</td><td>${raw.toFixed(2)}주</td></tr>
        <tr><td>확정 배정(소수점 버림)</td><td>${a.propWhole}주</td></tr>
        <tr><td>5사6입 적용 시</td><td>${a.propFrac>=0.6?(a.propWhole+1)+'주':a.propWhole+'주'}</td></tr>
      </tbody></table>
      <div class="cf-apply">소수점 <b>${a.propFrac}</b> ${a.propFrac>=0.6?'→ 0.6 이상이라 <b style="color:var(--positive)">1주 추가 가능</b>':'→ 0.5 이하라 <b style="color:var(--negative)">버려질 가능성 높음</b>'}</div>
      <p class="cf-note">5사6입은 소수점이 0.6 이상이면 올림하는 규칙입니다. 단, 단순 버림·추첨 등 종목·증권사마다 방식이 다릅니다.</p>`;
  }
  let bg=el('formula-pop-bg');
  if(!bg){
    bg=document.createElement('div');
    bg.id='formula-pop-bg';
    bg.className='formula-pop-bg';
    bg.onclick=e=>{ if(e.target===bg) closeFormulaPopup(); };
    document.body.appendChild(bg);
  }
  bg.innerHTML=`<div class="formula-pop">
    <div class="formula-pop-head"><strong>${h(ipo.name)} · ${title}</strong><button class="formula-pop-x" onclick="closeFormulaPopup()">✕</button></div>
    <div class="formula-pop-body">${body}</div>
  </div>`;
  bg.style.display='flex';
}
window.showAllocFormula=showAllocFormula;
function closeFormulaPopup(){ const bg=el('formula-pop-bg'); if(bg) bg.style.display='none'; }
window.closeFormulaPopup=closeFormulaPopup;

function _renderTimelineDay(day){
  const refundEvents=day.refunds.map(r=>`<div class="tl-event refund"><span class="tl-tag">환불</span><span class="tl-name">${r.ipo.name}${r.estimated?' <em>(예상)</em>':''}</span><span class="tl-amt">+${r.dep.toLocaleString()}원</span></div>`).join('');
  const subEvents=day.subs.map(s=>`<div class="tl-event sub"><span class="tl-tag">청약</span><span class="tl-name">${s.ipo.name}</span><span class="tl-amt">-${s.dep.toLocaleString()}원</span></div>`).join('');
  const shortEvents=(day.shorts||[]).map(s=>`<div class="tl-event short"><span class="tl-tag">자금부족</span><span class="tl-name">${s.ipo.name}</span><span class="tl-amt">최소 ${s.dep.toLocaleString()}원</span></div>`).join('');
  return `<div class="tl-day">
    <div class="tl-date">${_fmtKDateW(day.date)}</div>
    <div class="tl-body">
      ${refundEvents}${subEvents}${shortEvents}
      <div class="tl-balance">
        ${day.refundTotal>0?`<span class="tl-bal-step plus">환불 +${day.refundTotal.toLocaleString()}</span>`:''}
        ${day.subTotal>0?`<span class="tl-bal-step minus">청약 -${day.subTotal.toLocaleString()}</span>`:''}
        <span class="tl-bal-final ${day.afterSub<0?'neg':''}">잔액 ${day.afterSub.toLocaleString()}원</span>
      </div>
    </div>
  </div>`;
}
// ─────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────
function deleteIpo(id){
  if(!confirm('정말 삭제하시겠습니까?')) return;
  IPOS=IPOS.filter(i=>String(i.id)!==String(id));
  try{ const d=JSON.parse(localStorage.getItem(DEL_KEY)||'[]'); d.push(id); localStorage.setItem(DEL_KEY,JSON.stringify(d)); }catch(e){}
  saveAll(); closeModal(); renderCurrentTab(); notify('삭제되었습니다.','ok');
}
window.deleteIpo=deleteIpo;

function openAdminEdit(id){
  const ipo=IPOS.find(i=>String(i.id)===String(id)); if(!ipo) return;
  showAdminTab('manual');
  Object.keys(ipo).forEach(k=>{ const inp=el('af-'+k); if(inp) inp.value=Array.isArray(ipo[k])?ipo[k].join(', '):ipo[k]||''; });
  el('af-edit-id').value=id;
  el('af-submit-btn').textContent='저장';
}
window.openAdminEdit=openAdminEdit;

function showAdminTab(name){ switchTab('admin'); qsa('.admin-tab').forEach(t=>t.classList.toggle('on',t.dataset.tab===name)); qsa('.asec').forEach(s=>s.classList.toggle('on',s.id==='asec-'+name)); }

function renderAdminPanel(){
  const sortedIpos=[...IPOS].sort((a,b)=>{ const o={active:0,upcoming:1,listed:2,past:3}; return (o[calcStatus(a)]||3)-(o[calcStatus(b)]||3); });
  el('admin-panel-wrap').innerHTML=`
    <div style="margin-bottom:22px">
      <div style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:6px">ADMIN CONSOLE</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><h2 style="font-size:23px;font-weight:700;letter-spacing:-.01em;margin:0 0 4px">공모주 데이터 관리</h2><div style="font-size:13px;color:var(--text3)">증권신고서를 붙여넣어 자동 추출하거나 직접 종목을 추가·수정합니다.</div></div>
        <button class="btn btn-ghost" onclick="switchTab('dashboard')">← 홈으로</button>
      </div>
    </div>
    <div class="admin-tabs-row">
      <button class="admin-tab on" data-tab="parse" onclick="showAdminTab('parse')">증권신고서 자동 추출</button>
      <button class="admin-tab" data-tab="manual" onclick="showAdminTab('manual')">직접 입력</button>
      <button class="admin-tab" data-tab="manage" onclick="showAdminTab('manage')">종목 관리</button>
      <button class="admin-tab" data-tab="sync" onclick="showAdminTab('sync')">시세 동기화</button>
    </div>
    <div class="asec on" id="asec-parse">
      <div class="form-help"><strong>💡</strong> 금융감독원 DART에서 증권신고서 원문을 복사해 아래에 붙여넣고 자동 분석을 누르세요.</div>
      <div style="border:2px dashed var(--border);border-radius:11px;padding:16px;background:var(--bg)"><textarea id="raw-text" style="width:100%;min-height:260px;border:none;background:transparent;font-family:'Pretendard',monospace;font-size:13px;line-height:1.7;resize:vertical;outline:none" placeholder="증권신고서 본문을 붙여넣어 주세요..."></textarea></div>
      <button class="btn btn-gold" style="width:100%;margin-top:12px;padding:11px" onclick="parseRawText()">✨ 자동 분석 및 추출하기</button>
      <div id="parse-result" style="margin-top:14px"></div>
    </div>
    <div class="asec" id="asec-manual">
      <div class="form-help" id="af-help">모든 필드는 선택사항이지만 <strong>종목명</strong>은 필수입니다.</div>
      <input type="hidden" id="af-edit-id" value="">
      <div class="form-grid">
        ${adminField('name','종목명 *','예: 두산로보틱스','text',true)}
        ${adminField('sector','업종/섹터','예: 협동로봇 제조')}
        <div class="fld"><label>상장 시장</label><select id="af-market" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:13.5px;font-family:inherit"><option value="">코스닥</option><option>코스피</option><option>코넥스</option></select></div>
        ${adminField('priceRange[0]','희망 공모가 (하단)','예: 21000')}
        ${adminField('priceRange[1]','희망 공모가 (상단)','예: 26000')}
        ${adminField('finalPrice','확정 공모가','예: 26000')}
        ${adminField('subscribeStart','청약 시작일','2026-06-23','date')}
        ${adminField('subscribeEnd','청약 종료일','2026-06-24','date')}
        ${adminField('refundDate','환불일','2026-06-26','date')}
        ${adminField('listingDate','상장예정일','2026-07-10','date')}
        ${adminField('securities','주관사 (쉼표 구분)','예: 미래에셋증권, NH투자증권','text',true)}
        ${adminField('competitionRate','수요예측 경쟁률','예: 1500')}
        ${adminField('lockup','의무보유 확약 (%)','예: 74.5')}
        ${adminField('equalShares','균등배정 예상 주수','예: 5')}
        ${adminField('minDeposit','최소 청약 증거금','예: 53750')}
        ${adminField('d0High','상장일 D+0 최고가','예: 60000')}
        ${adminField('d1Close','D+1 종가','예: 45000')}
        ${adminField('d3Close','D+3 종가','예: 38000')}
        ${adminField('d7Close','D+7 종가','예: 32000')}
      </div>
      <div style="display:flex;gap:9px;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-ghost" onclick="clearAdminForm()">취소</button>
        <button id="af-submit-btn" class="btn btn-navy" onclick="submitAdminForm()">등록하기</button>
      </div>
    </div>
    <div class="asec" id="asec-manage">
      <div class="form-help"><strong>📋 전체 종목 관리</strong></div>
      <div class="alist">${sortedIpos.map(ipo=>`<div class="aitem"><div class="info">${statusBadge(calcStatus(ipo))}<div><div class="name">${ipo.name}</div><div class="meta">${(ipo.securities||[]).join(', ')||'주관사 미정'} · ${ipo.subscribeStart||'일정미정'}</div></div></div><div class="btns"><button onclick="openAdminEdit('${ipo.id}')">수정</button><button class="del" onclick="deleteIpo('${ipo.id}')">삭제</button></div></div>`).join('')}</div>
    </div>
    <div class="asec" id="asec-sync">
      <div class="form-help"><strong>🔄 데이터 수동 갱신</strong> · 재배포 직후 데이터가 비어 "준비 중"만 보일 때 눌러 즉시 수집합니다 (공공데이터 전일 종가).</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <button class="btn btn-navy" style="padding:11px 18px" onclick="runCron('cron-price','상장후 시세')">💹 상장후 시세 수집</button>
        <button class="btn btn-navy" style="padding:11px 18px" onclick="runCron('cron-market','대시보드 시세')">📊 대시보드 시세 수집</button>
        <button class="btn btn-navy" style="padding:11px 18px" onclick="forceUpdateHistory()">🔄 1주차 시세 동기화</button>
      </div>
      <div class="form-help" style="font-size:11px;color:var(--text3);line-height:1.6">
        브라우저 주소창에서 직접 실행도 가능합니다:<br>
        <code>/api/cron-price?adminPw=관리자암호</code><br>
        <code>/api/cron-market?adminPw=관리자암호</code><br>
        <code>/api/cron-dart?adminPw=관리자암호</code> (공시 수집 · <code>&amp;dry=1</code> 미리보기)
      </div>
    </div>`;
}

function adminField(k,lbl,ph,type='text',full=false){ return `<div class="fld${full?' full':''}"><label>${lbl}</label><input type="${type}" id="af-${k}" placeholder="${ph}"></div>`; }
function clearAdminForm(){ qsa('[id^="af-"]').forEach(i=>{ if(i.type!=='hidden') i.value=''; }); el('af-edit-id').value=''; el('af-submit-btn').textContent='등록하기'; el('af-help').innerHTML='모든 필드는 선택사항이지만 <strong>종목명</strong>은 필수입니다.'; }
function submitAdminForm(){
  const name=(el('af-name').value||'').trim(); if(!name){ alert('종목명은 필수입니다.'); return; }
  const num=s=>s&&s.trim()?+s.replace(/,/g,''):null;
  const editId=el('af-edit-id').value||null;
  const secArr=(el('af-securities').value||'').split(',').map(s=>s.trim()).filter(Boolean);
  const data={ name, sector:el('af-sector').value.trim()||null, priceRange:[num(el('af-priceRange[0]').value),num(el('af-priceRange[1]').value)].filter(v=>v), finalPrice:num(el('af-finalPrice').value), subscribeStart:el('af-subscribeStart').value||null, subscribeEnd:el('af-subscribeEnd').value||null, refundDate:el('af-refundDate').value||null, listingDate:el('af-listingDate').value||null, securities:secArr.length?secArr:[], competitionRate:num(el('af-competitionRate').value), lockup:num(el('af-lockup').value), equalShares:num(el('af-equalShares').value), minDeposit:num(el('af-minDeposit').value), d0High:num(el('af-d0High').value), d1Close:num(el('af-d1Close').value), d3Close:num(el('af-d3Close').value), d7Close:num(el('af-d7Close').value) };
  if(editId){ const idx=IPOS.findIndex(i=>String(i.id)===String(editId)); if(idx>=0) IPOS[idx]={...IPOS[idx],...data}; notify('수정되었습니다.','ok'); }
  else { IPOS.push({id:Date.now(),status:'upcoming',code:'',...data}); notify('등록되었습니다.','ok'); }
  saveAll(); clearAdminForm(); showAdminTab('manage'); renderAdminPanel(); renderCurrentTab();
}

function parseRawText(){
  const text=el('raw-text').value; if(!text.trim()){ notify('원문을 입력해주세요.','err'); return; }
  const t=text.replace(/[\u3000\xa0]/g,' ').replace(/\r/g,''); const r={};
  const find=pats=>{ for(const p of pats){ const m=t.match(p); if(m&&m[1]) return m[1].trim().replace(/\s+/g,' '); } return null; };
  r.name=find([/(?:회사명|상호|발행회사명?)[\s:：]*(?:주식회사|\(주\))?[ ]?([가-힣A-Za-z0-9]+)/]);
  r.sector=find([/(?:업종|사업영역|주요사업)[\s:：]*([^\n]+?)(?:\n|$)/]);
  if(/코스피|유가증권시장/.test(t)) r.market='코스피'; else if(/코스닥/.test(t)) r.market='코스닥';
  const bm=t.match(/(?:희망\s*공모가(?:액)?)[\s:：]*([0-9,]+)\s*원?\s*[~∼\-–—]\s*([0-9,]+)\s*원?/);
  if(bm){ r.priceLow=+bm[1].replace(/,/g,''); r.priceHigh=+bm[2].replace(/,/g,''); }
  const fm=t.match(/(?:확정\s*공모가|최종\s*공모가)[\s:：]*([0-9,]+)\s*원/); if(fm) r.finalPrice=+fm[1].replace(/,/g,'');
  ['청약개시일','청약시작일'].forEach(k=>{ const m=t.match(new RegExp(k+'[\\s:：]*([0-9]{4}[.\\-/][0-9]{1,2}[.\\-/][0-9]{1,2})')); if(m&&!r.subscribeStart) r.subscribeStart=m[1].replace(/[./]/g,'-'); });
  ['청약종료일','청약마감일'].forEach(k=>{ const m=t.match(new RegExp(k+'[\\s:：]*([0-9]{4}[.\\-/][0-9]{1,2}[.\\-/][0-9]{1,2})')); if(m&&!r.subscribeEnd) r.subscribeEnd=m[1].replace(/[./]/g,'-'); });
  const sm=t.match(/(?:대표\s*주관사|주간사)[\s:：]*([가-힣A-Za-z\s,·&]+?)(?:\n|$)/); if(sm) r.securities=[sm[1].trim()];
  const items=Object.entries(r).filter(([,v])=>v!=null);
  el('parse-result').innerHTML=items.length?`<div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:10px;padding:16px"><div style="font-size:12px;font-weight:700;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em">추출 결과</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${items.map(([k,v])=>`<div><span style="font-size:11px;color:var(--text3)">${k}</span><div style="font-weight:600;font-size:13px">${v}</div></div>`).join('')}</div><button class="btn btn-navy" style="width:100%;margin-top:14px" onclick="showAdminTab('manual')">직접 입력 탭에서 확인 →</button></div>`
  :`<div style="color:var(--text3);font-size:13px;padding:12px">추출된 항목이 없습니다.</div>`;
  notify(`${items.length}개 항목 추출 완료`,'ok');
}

// ─────────────────────────────────────────────────────────────
// TAB ROUTING
// ─────────────────────────────────────────────────────────────
let currentTab='dashboard';
function switchTab(name, skipHash){
  if(name==='route') name='planner';
  if(name==='schedule'){ scheduleView='list'; name='calendar'; }
  else if(name==='calendar' && currentTab!=='calendar') scheduleView='calendar';
  currentTab=name;
  qsa('.tab-view').forEach(v=>v.classList.toggle('active',v.id==='tab-'+name));
  qsa('.nav-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  // 초보 가이드 버튼 활성 표시
  const gb=el('btn-guide'); if(gb) gb.classList.toggle('on',name==='guide');
  // URL 해시 갱신 (새로고침 시 현재 탭 유지)
  if(!skipHash){ try{ history.replaceState(null,'','#'+name); }catch(e){ location.hash=name; } }
  renderCurrentTab();
  logAction('tab', name);
  window.scrollTo(0,0);
}
window.switchTab=switchTab;
function renderCurrentTab(){
  switch(currentTab){
    case 'dashboard':   renderDashboard();   break;
    case 'calendar':    renderCalendar();    break;
    case 'strategy':    renderStrategy();    break;
    case 'performance': renderPerformance(); break;
    case 'planner':     renderPlanner();     break;
    case 'mypage':      renderMyPage();      break;
    case 'news':        renderNewsTab();     break;
    case 'admin':       renderAdminPanel();  break;
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT BINDINGS
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  loadAll();
  qsa('.nav-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
  el('view-all-link').addEventListener('click',e=>{ e.preventDefault(); switchTab('schedule'); });
  el('cal-prev').addEventListener('click',()=>{ calView.m--; if(calView.m<0){ calView.m=11; calView.y--; } renderCalendar(); });
  el('cal-next').addEventListener('click',()=>{ calView.m++; if(calView.m>11){ calView.m=0; calView.y++; } renderCalendar(); });
  el('cal-today-btn').addEventListener('click',()=>{ calView={y:TODAY.getFullYear(),m:TODAY.getMonth()}; calSel=new Date(TODAY); renderCalendar(); });
  const scheduleChips=el('schedule-filter-chips');
  if(scheduleChips) scheduleChips.addEventListener('click',e=>{ const c=e.target.closest('.chip'); if(!c) return; setScheduleFilter(c.dataset.filter); qsa('#schedule-filter-chips .chip').forEach(x=>x.classList.toggle('on',x===c)); });
  el('modal-close-btn').addEventListener('click',closeModal);
  el('ipo-modal').addEventListener('click',e=>{ if(e.target===el('ipo-modal')) closeModal(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeModal(); closeSearch(); } });
  const searchBtn=el('btn-search'); if(searchBtn) searchBtn.addEventListener('click',openSearch);
  el('admin-panel-btn').addEventListener('click',()=>switchTab('admin'));
  el('admin-exit-btn').addEventListener('click',()=>{ location.href=location.pathname; });
  // 캘린더 날짜 클릭 — 컨테이너에 1회 위임(매 렌더마다 셀 리스너를 붙이던 누수 제거)
  const calGrid=el('cal-grid'); if(calGrid) calGrid.addEventListener('click',e=>{ const cell=e.target.closest('.cal-day'); if(!cell) return; calSel=new Date(+cell.dataset.ts); renderCalendar(); });
  // Chart.js는 <head>에서 이미 동기 로드됨(중복 로드 제거). 혹시 미로딩이면 재시도.
  if(typeof Chart==='undefined'){ const script=document.createElement('script'); script.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'; script.onload=()=>{ if(currentTab==='performance') renderPerformance(); }; document.head.appendChild(script); }
  // URL 해시로 초기 탭 복원 (새로고침 시 현재 탭 유지)
  const validTabs=['dashboard','calendar','schedule','strategy','performance','planner','route','mypage','guide','news'];
  const hash=(location.hash||'').replace('#','');
  if(hash && validTabs.includes(hash)){ switchTab(hash, true); }
  else { renderDashboard(); }
  // 뒤로/앞으로 가기 대응
  window.addEventListener('hashchange',()=>{
    const h=(location.hash||'').replace('#','');
    if(h && validTabs.includes(h) && h!==currentTab) switchTab(h, true);
  });
  logAction('page_view', location.pathname);
});

// ─────────────────────────────────────────────────────────────
// 스테이징 전용: 공개 배포(promote) 버튼
// API_BASE===''(데이터/스테이징 사이트)에서만 노출. 공개(web)에선 API_BASE가 채워져 숨겨짐.
// ─────────────────────────────────────────────────────────────
function _initPromoteFab(){
  if(typeof API_BASE!=='undefined' && API_BASE!=='') return;   // 공개 사이트에는 표시 안 함
  if(document.getElementById('promote-fab')) return;
  const tag=document.createElement('div');
  tag.textContent='STAGING';
  tag.style.cssText='position:fixed;right:18px;bottom:56px;z-index:99998;background:#E8A33D;color:#1a1206;font-size:10px;font-weight:800;letter-spacing:.06em;padding:2px 8px;border-radius:5px;pointer-events:none';
  const b=document.createElement('button');
  b.id='promote-fab'; b.type='button'; b.textContent='🚀 공개 배포';
  b.title='스테이징 내용을 공개 사이트(cookie-ipo)로 배포';
  b.style.cssText='position:fixed;right:18px;bottom:18px;z-index:99999;background:#1E3A5F;color:#fff;border:none;border-radius:999px;padding:11px 18px;font-size:13px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer';
  b.onclick=runPromote;
  document.body.appendChild(tag); document.body.appendChild(b);
}
async function runPromote(){
  if(typeof API_BASE!=='undefined' && API_BASE!=='') return;
  if(!confirm('현재 스테이징 화면을 공개 사이트(cookie-ipo)로 배포합니다. 진행할까요?')) return;
  const pw=prompt('관리자 비밀번호를 입력하세요:');
  if(!pw) return;
  const b=document.getElementById('promote-fab'); const orig=b?b.textContent:'';
  if(b){ b.disabled=true; b.textContent='배포 중…'; }
  try{
    const r=await fetch('/api/promote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminPw:pw})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok) alert('✅ '+(j.message||'공개 사이트에 반영했습니다.')+(j.commit?`\n커밋 ${j.commit}`:''));
    else alert('❌ 배포 실패: '+(j.error||('HTTP '+r.status))+(j.detail?`\n${j.detail}`:''));
  }catch(e){ alert('❌ 네트워크 오류: '+e.message); }
  finally{ if(b){ b.disabled=false; b.textContent=orig||'🚀 공개 배포'; } }
}
window.runPromote=runPromote;
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', _initPromoteFab); else _initPromoteFab();
