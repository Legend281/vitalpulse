import { describe, expect, it, vi } from 'vitest';

// donor-dashboard.js no longer calls firebase/functions itself (KYC moved off Cloud
// Functions per donor UI/KYC_fix.md), but it imports from ./db, which still does at module
// load time for other Cloud Functions (suspendUser, roles, etc.) — this mock is for that
// transitive import, not for anything in this file directly.
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./auth', () => ({ getCurrentUser: vi.fn(), sendPasswordReset: vi.fn(), hashNationalId: vi.fn() }));

import { validateKycFile, resolveLastDonationDate, getEligibilityInfo, BLOOD_COMPATIBILITY_DATA } from './donor-dashboard.js';

function makeFile({ type = 'image/jpeg', size = 1024, name = 'id.jpg' } = {}) {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe('getEligibilityInfo (56-Day WHO Interval Calculation)', () => {
  it('returns eligible when no prior donation exists', () => {
    const res = getEligibilityInfo(null);
    expect(res.eligible).toBe(true);
    expect(res.daysUntil).toBe(0);
    expect(res.label).toBe('Eligible');
  });

  it('returns eligible when donation was more than 56 days ago', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const res = getEligibilityInfo(sixtyDaysAgo);
    expect(res.eligible).toBe(true);
    expect(res.daysUntil).toBe(0);
    expect(res.label).toBe('Eligible');
  });

  it('returns ineligible with accurate countdown when donation was 20 days ago', () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const res = getEligibilityInfo(twentyDaysAgo);
    expect(res.eligible).toBe(false);
    expect(res.daysUntil).toBe(36);
    expect(res.label).toBe('36 days');
  });
});

describe('BLOOD_COMPATIBILITY_DATA (Transfusion Matrix for Cameroon)', () => {
  it('has all 8 clinical blood types defined', () => {
    const types = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
    types.forEach(bt => {
      expect(BLOOD_COMPATIBILITY_DATA[bt]).toBeDefined();
      expect(BLOOD_COMPATIBILITY_DATA[bt].give.length).toBeGreaterThan(0);
      expect(BLOOD_COMPATIBILITY_DATA[bt].receive.length).toBeGreaterThan(0);
    });
  });

  it('verifies O- is the universal red cell donor (can give to all 8 groups)', () => {
    expect(BLOOD_COMPATIBILITY_DATA['O-'].give).toEqual(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']);
  });

  it('verifies AB+ is the universal receiver (can receive from all 8 groups)', () => {
    expect(BLOOD_COMPATIBILITY_DATA['AB+'].receive).toEqual(
      expect.arrayContaining(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'])
    );
    expect(BLOOD_COMPATIBILITY_DATA['AB+'].receive.length).toBe(8);
  });
});

describe('resolveLastDonationDate (56-Day WHO Deferral Tracking)', () => {
  it('returns null when no donation date exists on user or engagement', () => {
    expect(resolveLastDonationDate(null, null)).toBeNull();
    expect(resolveLastDonationDate({ name: 'John' }, { donations: [] })).toBeNull();
  });

  it('resolves lastDonationDate from currentUser profile', () => {
    const user = { lastDonationDate: '2026-07-29T10:00:00.000Z' };
    expect(resolveLastDonationDate(user, null)).toEqual('2026-07-29T10:00:00.000Z');
  });

  it('resolves lastDonatedAt from currentUser profile if lastDonationDate is missing', () => {
    const user = { lastDonatedAt: '2026-07-20T10:00:00.000Z' };
    expect(resolveLastDonationDate(user, null)).toEqual('2026-07-20T10:00:00.000Z');
  });

  it('picks the most recent date between profile lastDonationDate and engagement history', () => {
    const user = { lastDonationDate: '2026-07-29T10:00:00.000Z' }; // 8 days ago
    const engagement = {
      donations: [
        { status: 'completed', completedAt: '2026-05-01T10:00:00.000Z' } // older
      ]
    };
    // Must pick the July 29 date (8 days ago) rather than ignoring it!
    expect(resolveLastDonationDate(user, engagement)).toEqual('2026-07-29T10:00:00.000Z');
  });

  it('picks completedAt from engagement if it is more recent than profile date', () => {
    const user = { lastDonationDate: '2026-01-01T10:00:00.000Z' };
    const engagement = {
      donations: [
        { status: 'completed', completedAt: '2026-08-01T10:00:00.000Z' }
      ]
    };
    expect(resolveLastDonationDate(user, engagement)).toEqual('2026-08-01T10:00:00.000Z');
  });
});

describe('validateKycFile (donor UI/KYC_fix.md, KYC upload)', () => {
  it('accepts a valid JPG under 5MB', () => {
    expect(validateKycFile(makeFile({ type: 'image/jpeg', size: 1024 }))).toEqual({ valid: true, error: null });
  });

  it('accepts a valid PNG', () => {
    expect(validateKycFile(makeFile({ type: 'image/png' })).valid).toBe(true);
  });

  it('HOSTILE: rejects a missing file', () => {
    expect(validateKycFile(null)).toEqual({ valid: false, error: "Please choose a file." });
  });

  it('HOSTILE: rejects PDF — no longer accepted (canvas-based compression can only resize a raster image, not render a PDF page)', () => {
    const result = validateKycFile(makeFile({ type: 'application/pdf' }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
  });

  it('HOSTILE: rejects an unsupported format', () => {
    const result = validateKycFile(makeFile({ type: 'application/zip' }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
  });

  it('HOSTILE: rejects a file over 5MB', () => {
    const result = validateKycFile(makeFile({ size: 5 * 1024 * 1024 + 1 }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too large/);
  });

  it('HOSTILE: rejects an empty file', () => {
    const result = validateKycFile(makeFile({ size: 0 }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/);
  });

  it('accepts a file exactly at the 5MB boundary', () => {
    expect(validateKycFile(makeFile({ size: 5 * 1024 * 1024 })).valid).toBe(true);
  });
});

describe('switchDonorView and Mobile Navigation', () => {
  it('switches views and toggles hidden classes for centers and profile without throwing', async () => {
    document.body.innerHTML = `
      <div id="viewTransitionLoader" class="hidden"></div>
      <div id="viewTransitionText"></div>
      <div id="view-dashboard" class="block"></div>
      <div id="view-centers" class="hidden"></div>
      <div id="view-profile" class="hidden"></div>
      <div id="centersMapCol" class="hidden lg:block"></div>
      <div id="centersListCol" class="w-full"></div>
      <button id="btnCentersMobileList"></button>
      <button id="btnCentersMobileMap"></button>
    `;

    // Should switch to profile cleanly
    const { switchDonorView } = await import('./donor-dashboard.js');
    await switchDonorView('profile');

    expect(document.getElementById('view-profile').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('view-dashboard').classList.contains('hidden')).toBe(true);

    // Should switch to centers cleanly
    await switchDonorView('centers');
    expect(document.getElementById('view-centers').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('view-profile').classList.contains('hidden')).toBe(true);
  });
});

describe('REALISTIC_MEDALS & Gamified Honors Exhibition Architecture', () => {
  it('contains exactly 8 clinical tiers and lifesaver quest honors', async () => {
    const { REALISTIC_MEDALS } = await import('./donor-dashboard.js');
    expect(REALISTIC_MEDALS.length).toBe(8);

    const ids = REALISTIC_MEDALS.map(m => m.id);
    expect(ids).toContain('bronze_lifesaver');
    expect(ids).toContain('silver_sentinel');
    expect(ids).toContain('gold_guardian');
    expect(ids).toContain('platinum_protector');
    expect(ids).toContain('diamond_hero');
    expect(ids).toContain('rapid_responder');
    expect(ids).toContain('standby_envoy');
    expect(ids).toContain('rhythm_champion');

    // Never includes store merchandise/vouchers in honors exhibition
    expect(ids).not.toContain('master_donor_pin');
    expect(ids).not.toContain('health_scholar');
  });

  it('configures Platinum Vanguard with photorealistic transparent asset and 10-donation tier', async () => {
    const { REALISTIC_MEDALS } = await import('./donor-dashboard.js');
    const plat = REALISTIC_MEDALS.find(m => m.id === 'platinum_protector');
    expect(plat).toBeDefined();
    expect(plat.image).toBe('/assets/badge_platinum_star_transparent.png');
    expect(plat.reqDonations).toBe(10);
    expect(plat.points).toBe(1000);
  });
});

describe('Pulse Points Vault & Healthcare Rewards Architecture', () => {
  it('exports PULSE_REWARDS with correct costs, perks, and high-res imagery', async () => {
    const { PULSE_REWARDS } = await import('./donor-dashboard.js');
    expect(PULSE_REWARDS.length).toBe(3);

    const lab = PULSE_REWARDS.find(r => r.key === 'lab_voucher');
    expect(lab).toBeDefined();
    expect(lab.cost).toBe(300);
    expect(lab.image).toBe('/assets/reward_lab_voucher_card.jpg');
    expect(lab.perks.length).toBeGreaterThanOrEqual(3);

    const pin = PULSE_REWARDS.find(r => r.key === 'lapel_pin');
    expect(pin).toBeDefined();
    expect(pin.cost).toBe(500);
    expect(pin.image).toBe('/assets/reward_enamel_pin_card.jpg');

    const vip = PULSE_REWARDS.find(r => r.key === 'vip_pass');
    expect(vip).toBeDefined();
    expect(vip.cost).toBe(750);
    expect(vip.image).toBe('/assets/reward_vip_pass_card.jpg');
  });

  it('renders dynamic affordability progress bars when donor has 85 points', async () => {
    const { renderRewardsCatalog } = await import('./donor-dashboard.js');
    document.body.innerHTML = `
      <div id="vaultCatalogGrid"></div>
      <span id="vaultVouchersCountBadge">0</span>
    `;

    // Render with 85 points (the user balance in current state)
    renderRewardsCatalog(85);

    const grid = document.getElementById('vaultCatalogGrid');
    expect(grid.innerHTML).toContain('Progress: 85 / 300 pts');
    expect(grid.innerHTML).toContain('28%');
    expect(grid.innerHTML).toContain('Need <strong class="text-amber-300">215 more pts</strong>');
    expect(grid.innerHTML).toContain('Need 215 More Pts • How to Earn');

    // 500 pt pin
    expect(grid.innerHTML).toContain('Progress: 85 / 500 pts');
    expect(grid.innerHTML).toContain('17%');
    expect(grid.innerHTML).toContain('Need 415 More Pts • How to Earn');

    // 750 pt pass
    expect(grid.innerHTML).toContain('Progress: 85 / 750 pts');
    expect(grid.innerHTML).toContain('11%');
    expect(grid.innerHTML).toContain('Need 665 More Pts • How to Earn');
  });

  it('renders ready-to-redeem state when donor has sufficient points', async () => {
    const { renderRewardsCatalog } = await import('./donor-dashboard.js');
    document.body.innerHTML = `<div id="vaultCatalogGrid"></div>`;

    // Render with 400 points
    renderRewardsCatalog(400);

    const grid = document.getElementById('vaultCatalogGrid');
    // Lab voucher is 300 pts -> affordable!
    expect(grid.innerHTML).toContain('Ready to Redeem');
    expect(grid.innerHTML).toContain('Redeem Voucher (300 pts)');

    // Pin is 500 pts -> still needs 100
    expect(grid.innerHTML).toContain('Progress: 400 / 500 pts');
    expect(grid.innerHTML).toContain('80%');
    expect(grid.innerHTML).toContain('Need 100 More Pts • How to Earn');
  });

  it('updates the active vouchers badge counter correctly', async () => {
    const { updateActiveVouchersBadge } = await import('./donor-dashboard.js');
    document.body.innerHTML = `<span id="vaultVouchersCountBadge">0</span>`;

    updateActiveVouchersBadge(3);
    const badge = document.getElementById('vaultVouchersCountBadge');
    expect(badge.textContent).toBe('3');
  });
});

describe('Category A: Schedule Modal Alias & ABO Compatibility Flyout', () => {
  it('exposes window.openScheduleModal as an alias to window.openDonationModal', async () => {
    await import('./donor-dashboard.js');
    expect(typeof window.openDonationModal).toBe('function');
    expect(window.openScheduleModal).toBe(window.openDonationModal);
  });

  it('toggles #bloodCompatibilityFlyout visibility when window.toggleBloodFlyout is invoked', async () => {
    document.body.innerHTML = `<div id="bloodCompatibilityFlyout" class="hidden"></div>`;
    await import('./donor-dashboard.js');

    const flyout = document.getElementById('bloodCompatibilityFlyout');
    expect(flyout.classList.contains('hidden')).toBe(true);

    window.toggleBloodFlyout();
    expect(flyout.classList.contains('hidden')).toBe(false);

    window.toggleBloodFlyout();
    expect(flyout.classList.contains('hidden')).toBe(true);
  });
});

describe('Category C: Unified Standby State & Certificate Modal Hydration', () => {
  it('isDonorOnStandby and syncDonorStandbyDOM keep Dashboard and Profile standby indicators in sync', async () => {
    document.body.innerHTML = `
      <span id="availabilityTrack"></span>
      <span id="availabilityThumb"></span>
      <span id="donorStatusLabel"></span>
      <span id="donorProfileStandbyBeacon"></span>
      <span id="btnToggleStandbyLabel"></span>
      <button id="btnToggleStandbyStatus"></button>
    `;
    const { isDonorOnStandby, syncDonorStandbyDOM } = await import('./donor-dashboard.js');

    expect(isDonorOnStandby({ isAvailable: false, standbyStatus: 'available' })).toBe(false);
    expect(isDonorOnStandby({ standbyStatus: 'busy' })).toBe(false);
    expect(isDonorOnStandby({ standbyStatus: 'available' })).toBe(true);

    syncDonorStandbyDOM(false);
    expect(document.getElementById('donorStatusLabel').textContent).toBe('BUSY');
    expect(document.getElementById('btnToggleStandbyLabel').textContent).toBe('Standby: Paused');

    syncDonorStandbyDOM(true);
    expect(document.getElementById('donorStatusLabel').textContent).toBe('AVAILABLE');
    expect(document.getElementById('btnToggleStandbyLabel').textContent).toBe('Standby: Active');
  });

  it('openLifesaverCertificateModal hydrates certificate diploma from window._loadedCertificatesList', async () => {
    document.body.innerHTML = `
      <div id="modalLifesaverCertificate" class="hidden"></div>
      <div id="modalLifesaverCertificateContent"></div>
    `;
    await import('./donor-dashboard.js');
    window._loadedCertificatesList = [
      {
        id: 'cert_99',
        certificateNumber: 'VP-CERT-999888',
        checkInToken: 'VP-999888',
        donorName: 'Amina Ndam',
        hospitalName: 'Laquintinie Hospital Douala',
        bloodType: 'O-',
        unitsDonated: 2,
        issuedDate: '2026-09-15T10:00:00.000Z',
      },
    ];

    window.openLifesaverCertificateModal('cert_99');
    const content = document.getElementById('modalLifesaverCertificateContent');
    expect(content.innerHTML).toContain('VP-CERT-999888');
    expect(content.innerHTML).toContain('Laquintinie Hospital Douala');
    expect(content.innerHTML).toContain('Amina Ndam');
  });
});

describe('Category D: Dynamic Dashboard Medals Strip & Data Hydration', () => {
  it('renderDashboardMedalsStrip renders locked medals with progress when donor has 0 donations', async () => {
    document.body.innerHTML = `<div id="dashboardMedalsStrip"></div>`;
    const { renderDashboardMedalsStrip } = await import('./donor-dashboard.js');

    renderDashboardMedalsStrip({ donationCount: 0 }, false);
    const strip = document.getElementById('dashboardMedalsStrip');
    expect(strip.textContent).toContain('0/1 req');
    expect(strip.textContent).toContain('0/3 req');
    expect(strip.textContent).toContain('0/5 req');
    expect(strip.textContent).toContain('0/10 req');
    expect(strip.textContent).not.toContain('Unlocked');
    expect(strip.textContent).toContain('Platinum Vanguard');
  });

  it('renderDashboardMedalsStrip unlocks Bronze and Silver when donor has 3 donations', async () => {
    document.body.innerHTML = `<div id="dashboardMedalsStrip"></div>`;
    const { renderDashboardMedalsStrip } = await import('./donor-dashboard.js');

    renderDashboardMedalsStrip({ donationCount: 3 }, false);
    const strip = document.getElementById('dashboardMedalsStrip');
    expect(strip.textContent).toContain('Unlocked • Bronze Shield');
    expect(strip.textContent).toContain('Unlocked • Silver Star');
    expect(strip.textContent).toContain('3/5 req');
    expect(strip.textContent).toContain('3/10 req');
  });

  it('isRequestWithin24Hours returns true for requests under 24h old and false for older requests', async () => {
    const { isRequestWithin24Hours } = await import('./donor-dashboard.js');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

    expect(isRequestWithin24Hours({ requestedAt: twoHoursAgo })).toBe(true);
    expect(isRequestWithin24Hours({ requestedAt: thirtyHoursAgo })).toBe(false);
    expect(isRequestWithin24Hours(null)).toBe(false);
  });
});
