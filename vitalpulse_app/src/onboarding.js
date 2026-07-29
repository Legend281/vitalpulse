const ONBOARDING_KEY = 'vitalpulse_onboarding_done';

const donorSteps = [
  {
    title: 'Welcome to VitalPulse!',
    description: 'You are now a registered blood donor. Your blood can save lives across Cameroon.',
    icon: 'volunteer_activism',
    selector: null
  },
  {
    title: 'Find Blood Requests',
    description: 'Check the "Requests" tab for emergency blood requests matching your blood type in your city.',
    icon: 'bloodtype',
    selector: '[data-view="requests"]'
  },
  {
    title: 'Accept & Donate',
    description: 'Tap "Accept" on a request, then mark "En Route" when you head to the hospital.',
    icon: 'directions_run',
    selector: null
  },
  {
    title: 'Earn Badges & Rewards',
    description: 'Each donation earns you points. Climb from Bronze to Platinum tier and unlock badges!',
    icon: 'workspace_premium',
    selector: '[data-view="badges"]'
  }
];

const hospitalSteps = [
  {
    title: 'Welcome to VitalPulse!',
    description: 'Your hospital is now connected to Cameroon\'s emergency blood donation network.',
    icon: 'local_hospital',
    selector: null
  },
  {
    title: 'Create Blood Requests',
    description: 'Use the "Requests" tab to create emergency or standard blood requests. Auto-match finds compatible donors.',
    icon: 'add_circle',
    selector: '#nav-requests'
  },
  {
    title: 'Manage Inventory',
    description: 'Track blood stock by type and component. Set thresholds and receive low-stock alerts.',
    icon: 'inventory_2',
    selector: '#nav-inventory'
  },
  {
    title: 'Coordinate Donors',
    description: 'View incoming donors, mark them arrived, and complete the donation cycle.',
    icon: 'groups',
    selector: '#nav-donors'
  }
];

// Scoped per account (not just per browser) — otherwise one user dismissing
// onboarding on a shared computer would silently suppress it for every other
// account (donor or hospital) that later logs in on that same browser.
export function shouldShowOnboarding(userId) {
  if (!userId) return false;
  return !localStorage.getItem(`${ONBOARDING_KEY}_${userId}`);
}

export function markOnboardingComplete(userId) {
  if (!userId) return;
  localStorage.setItem(`${ONBOARDING_KEY}_${userId}`, 'true');
}

export function startOnboarding(role, userId) {
  const steps = role === 'hospital' ? hospitalSteps : donorSteps;

  const overlay = document.createElement('div');
  overlay.id = 'onboardingOverlay';
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm';

  let currentStep = 0;

  function renderStep() {
    const step = steps[currentStep];
    const isLast = currentStep === steps.length - 1;

    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center animate-in">
        <div class="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center mx-auto mb-4">
          <span class="material-symbols-outlined text-3xl text-red-600">${step.icon}</span>
        </div>
        <h3 class="text-lg font-extrabold text-on-surface mb-2">${step.title}</h3>
        <p class="text-sm text-slate-600 mb-6">${step.description}</p>
        <div class="flex items-center justify-center gap-1.5 mb-6">
          ${steps.map((_, i) => `
            <span class="w-2 h-2 rounded-full ${i === currentStep ? 'bg-red-600 w-4' : 'bg-slate-300'} transition-all"></span>
          `).join('')}
        </div>
        <div class="flex gap-3">
          <button onclick="document.getElementById('onboardingOverlay')?.remove(); window.markOnboardingComplete?.();" class="flex-1 text-xs font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 px-4 py-2.5 rounded-xl transition-colors">
            Skip
          </button>
          <button id="onboardingNextBtn" class="flex-1 text-xs font-bold text-white bg-red-600 hover:bg-red-700 px-4 py-2.5 rounded-xl transition-colors">
            ${isLast ? 'Get Started' : 'Next'}
          </button>
        </div>
      </div>
    `;

    const nextBtn = document.getElementById('onboardingNextBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (isLast) {
          overlay.remove();
          markOnboardingComplete(userId);
          if (step.selector) {
            const el = document.querySelector(step.selector);
            if (el) {
              el.classList.add('ring-2', 'ring-red-400', 'ring-offset-2');
              setTimeout(() => el.classList.remove('ring-2', 'ring-red-400', 'ring-offset-2'), 2000);
            }
          }
        } else {
          currentStep++;
          renderStep();
        }
      });
    }
  }

  document.body.appendChild(overlay);
  renderStep();
}
