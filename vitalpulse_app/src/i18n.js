const translations = {
  en: {
    dashboard: 'Dashboard',
    requests: 'Requests',
    inventory: 'Inventory',
    donors: 'Donors',
    settings: 'Settings',
    campaigns: 'Campaigns',
    'hospital control center': 'Hospital Control Center',
    'notification history': 'Notification History',
    'activity log': 'Activity Log',
    'total units': 'Total Units',
    'low stock': 'Low Stock',
    'healthy types': 'Healthy Types',
    'expiring soon': 'Expiring Soon',
    threshold: 'Threshold',
    'add stock': 'Add Stock',
    'issue to patient': 'Issue to Patient',
    'remove stock': 'Remove Stock',
    accept: 'Accept',
    reject: 'Reject',
    save: 'Save',
    cancel: 'Cancel',
    submit: 'Submit',
    add: 'Add',
    remove: 'Remove',
    issue: 'Issue',
    print: 'Print',
    export: 'Export',
    search: 'Search',
    filter: 'Filter',
    clear: 'Clear',
    confirm: 'Confirm',
    open: 'Open',
    matching: 'Matching',
    'donor assigned': 'Donor Assigned',
    'donor en route': 'Donor En Route',
    resolved: 'Resolved',
    pending: 'Pending',
    approved: 'Approved',
    completed: 'Completed',
    cancelled: 'Cancelled',
    active: 'Active',
    planning: 'Planning',
    loading: 'Loading...',
    'no data': 'No data available',
    'no notifications': 'No notifications yet',
    success: 'Success',
    error: 'Error',
    warning: 'Warning',
    info: 'Info',
    'mark all read': 'Mark all read',
    'view all': 'View all',
    home: 'Home',
    centers: 'Centers',
    impact: 'Impact',
    profile: 'Profile',
    'donation centers': 'Donation Centers',
    'impact & badges': 'Impact & Badges',
  },
  fr: {
    dashboard: 'Tableau de Bord',
    requests: 'Demandes',
    inventory: 'Inventaire',
    donors: 'Donneurs',
    settings: 'Paramètres',
    campaigns: 'Campagnes',
    'hospital control center': 'Centre de Contrôle',
    'notification history': 'Historique des Notifications',
    'activity log': "Journal d'Activité",
    'total units': 'Unités Totales',
    'low stock': 'Stock Faible',
    'healthy types': 'Types Sains',
    'expiring soon': 'Expire Bientôt',
    threshold: 'Seuil',
    'add stock': 'Ajouter du Stock',
    'issue to patient': 'Distribuer au Patient',
    'remove stock': 'Retirer du Stock',
    accept: 'Accepter',
    reject: 'Refuser',
    save: 'Enregistrer',
    cancel: 'Annuler',
    submit: 'Soumettre',
    add: 'Ajouter',
    remove: 'Retirer',
    issue: 'Distribuer',
    print: 'Imprimer',
    export: 'Exporter',
    search: 'Rechercher',
    filter: 'Filtrer',
    clear: 'Effacer',
    confirm: 'Confirmer',
    open: 'Ouvert',
    matching: 'Correspondance',
    'donor assigned': 'Donneur Assigné',
    'donor en route': 'Donneur en Route',
    resolved: 'Résolu',
    pending: 'En Attente',
    approved: 'Approuvé',
    completed: 'Terminé',
    cancelled: 'Annulé',
    active: 'Actif',
    planning: 'Planification',
    loading: 'Chargement...',
    'no data': 'Aucune donnée',
    'no notifications': 'Aucune notification',
    success: 'Succès',
    error: 'Erreur',
    warning: 'Avertissement',
    info: 'Info',
    'mark all read': 'Tout marquer lu',
    'view all': 'Voir tout',
    home: 'Accueil',
    centers: 'Centres',
    impact: 'Impact',
    profile: 'Profil',
    'donation centers': 'Centres de Don',
    'impact & badges': 'Impact et Badges',
  }
};

let currentLang = localStorage.getItem('vitalpulse_lang') || 'en';

export function t(key) {
  const keys = key.toLowerCase().split('.');
  let val = translations[currentLang];
  for (const k of keys) {
    if (val && val[k] !== undefined) val = val[k];
    else return key;
  }
  return val || key;
}

export function setLang(lang) {
  if (translations[lang]) {
    currentLang = lang;
    localStorage.setItem('vitalpulse_lang', lang);
    window.dispatchEvent(new CustomEvent('languagechange', { detail: lang }));
  }
}

export function getLang() {
  return currentLang;
}

export function __(key) {
  return t(key);
}

export function injectLangToggle() {
  const existing = document.getElementById('langToggle');
  if (existing) return;

  const toggle = document.createElement('div');
  toggle.id = 'langToggle';
  toggle.className = 'fixed bottom-4 right-4 z-50 flex items-center gap-1 bg-white/90 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-lg border border-slate-200 text-xs font-bold';
  toggle.innerHTML = `
    <button data-lang="en" class="px-2 py-0.5 rounded-full transition-colors ${currentLang === 'en' ? 'bg-red-600 text-white' : 'text-slate-500 hover:text-red-600'}">EN</button>
    <span class="text-slate-300">|</span>
    <button data-lang="fr" class="px-2 py-0.5 rounded-full transition-colors ${currentLang === 'fr' ? 'bg-red-600 text-white' : 'text-slate-500 hover:text-red-600'}">FR</button>
  `;

  toggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      setLang(btn.dataset.lang);
      toggle.querySelectorAll('button').forEach(b => {
        b.className = `px-2 py-0.5 rounded-full transition-colors ${b.dataset.lang === getLang() ? 'bg-red-600 text-white' : 'text-slate-500 hover:text-red-600'}`;
      });
    });
  });

  document.body.appendChild(toggle);
}
