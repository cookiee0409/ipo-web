/**
 * ipos-seed.js — 기본 공모주 종목 (앱 + 관리자 공통 소스)
 *
 * app.js와 admin.html 양쪽에서 <script src="ipos-seed.js"></script>로 불러옵니다.
 * window.IPOS_SEED 전역으로 노출됩니다.
 *
 * [중요] 아래 배열은 비어 있습니다. 실제 공모주 데이터는 관리자 페이지(admin.html)에서
 * 직접 입력하여 DB(/api/ipos)에 저장합니다. DB가 비어 있을 때만 이 시드가 폴백으로 사용됩니다.
 * 과거 더미/예시 데이터는 파일 하단에 주석으로 보존되어 있습니다(필요 시 참고).
 */
window.IPOS_SEED = [];

/* ───────────────────────────────────────────────────────────────
[더미·예시 데이터 보존 — 실제 운영 시에는 admin에서 실제 종목 입력]
실제 공모주 일정·가격·경쟁률은 DART(dart.fss.or.kr), 38커뮤니케이션(38.co.kr) 등에서
확인하여 관리자 페이지에 입력하세요. 아래 값들은 앱 동작 테스트용 예시입니다.

  { id:1, name:'(예시)종목A', code:'', status:'upcoming', subscribeStart:'', subscribeEnd:'', refundDate:'', listingDate:null, priceRange:[0,0], finalPrice:null, securities:[], minDeposit:0, totalShares:null, sector:'', competitionRate:null, lockup:null, lockupDate:null, equalShares:null },
─────────────────────────────────────────────────────────────── */
