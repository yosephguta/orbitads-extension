/**
 * DealersOrbit Popup
 * ───────────────
 * Handles three states:
 *   1. Not logged in → show login form
 *   2. Logged in, queue empty → show empty state
 *   3. Logged in, queue has items → show queue with progress
 *
 * Reads queue from chrome.storage.local (set by background.js)
 * Polls for updates every 2 seconds while popup is open
 */

// ── Config ────────────────────────────────────────────────────
// Change to https://api.dealersorbit.com when deployed
// ── Config ────────────────────────────────────────────────────
// Automatically use localhost when loaded as an unpacked (dev) extension.
// Published Chrome Web Store builds always have update_url in the manifest.
const IS_DEV = !("update_url" in chrome.runtime.getManifest());
const API_BASE = IS_DEV
  ? "http://localhost:8000/api/v1"
  : "https://api.dealersorbit.com/api/v1";

// ── Elements ──────────────────────────────────────────────────
const dashboardScreen = document.getElementById("dashboardScreen");
const reviewQueueContainer = document.getElementById("reviewQueueCards") || document.createElement("div"); const settingsScreen = document.getElementById("settingsScreen");
const settingsBackBtn = document.getElementById("settingsBackBtn");
const settingsBtn = document.getElementById("settingsBtn");
const helpBtn = document.getElementById("helpBtn");
const siteBtn = document.getElementById("siteBtn");
const signOutBtn = document.getElementById("signOutBtn");
const statAdsToday = document.getElementById("statAdsToday");
const statAdsWeek = document.getElementById("statAdsWeek");
const statAdsTotal = document.getElementById("statAdsTotal");
const statFbPosted = document.getElementById("statFbPosted");
const queueEmpty = document.getElementById("queueEmpty");
const recentAds = document.getElementById("recentAds");
const videoTypeSelectDash = document.getElementById("videoTypeSelectDash");
const loginScreen = document.getElementById("loginScreen");
const emptyScreen = document.getElementById("emptyScreen");
const userInfo = document.getElementById("userInfo");
const userName = document.getElementById("userName");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn") || document.createElement("button");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const jobList = document.getElementById("jobList");
const queueCount = document.getElementById("queueCount");
const backBtn = document.getElementById("backBtn");
const reviewScreen = document.getElementById("reviewScreen");
const reviewTitle = document.getElementById("reviewTitle");
const reviewMeta = document.getElementById("reviewMeta");
const reviewStatus = document.getElementById("reviewStatus");
const reviewSections = document.getElementById("reviewSections");
const generateBtn = document.getElementById("generateBtn") || document.createElement("button");
const uploadInput = document.getElementById("uploadInput");
const facebookBtn = document.getElementById("facebookBtn") || document.createElement("button");
const fbSuccessBanner = document.getElementById("fbSuccessBanner");
const fbListingScreen = document.getElementById("fbListingScreen") || document.createElement("div");
const fbBackBtn = document.getElementById("fbBackBtn") || document.createElement("button");
const fbListingTitle = document.getElementById("fbListingTitle") || document.createElement("div");
const fbListingMeta = document.getElementById("fbListingMeta") || document.createElement("div");
const fbTitleText = document.getElementById("fbTitleText") || document.createElement("div");
const fbPriceText = document.getElementById("fbPriceText") || document.createElement("div");
const fbDescText = document.getElementById("fbDescText") || document.createElement("div");
const fbTagsWrap = document.getElementById("fbTagsWrap") || document.createElement("div");
const fbPostingStatus = document.getElementById("fbPostingStatus") || document.createElement("div");
const fbStatusLabel = document.getElementById("fbStatusLabel") || document.createElement("div");
const fbQueueList = document.getElementById("fbQueueList") || document.createElement("div");
const openFbBtn = document.getElementById("openFbBtn") || document.createElement("button");
const copyAllBtn = document.getElementById("copyAllBtn") || document.createElement("button");
const generateModal = document.getElementById("generateModal");
const closeModal = document.getElementById("closeModal");
const modalStep1 = document.getElementById("modalStep1");
const modalStep2 = document.getElementById("modalStep2");
const modalStep3 = document.getElementById("modalStep3");
const modalStep4 = document.getElementById("modalStep4");
const modalStepOutro = document.getElementById("modalStepOutro");
const modalVehicleTitle = document.getElementById("modalVehicleTitle");
const soldModal = document.getElementById("soldModal");
const soldCheckerStat = document.getElementById("soldCheckerStat");
const statSoldCount = document.getElementById("statSoldCount");

// ── Session helpers ───────────────────────────────────────────
async function handleSessionExpired() {
  if (isLoggingIn) return;
  if (queueInterval) { clearInterval(queueInterval); queueInterval = null; }
  await chrome.storage.local.remove(["token", "user"]);
  userInfo.style.display = "none";
  loginError.textContent = "Your session has expired. Please sign in again.";
  showScreen(loginScreen);
}

// Drop-in replacement for fetch() on authenticated calls.
// Intercepts 401 responses and logs the user out automatically.
async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  if (resp.status === 401) {
    await handleSessionExpired();
    throw new Error("session_expired");
  }
  return resp;
}

// ── Subscription ──────────────────────────────────────────────
async function checkSubscriptionStatus() {
  const { token, subscription_cache } =
    await chrome.storage.local.get(["token", "subscription_cache"]);

  if (!token) return null;

  const ONE_HOUR = 60 * 60 * 1000;
  if (subscription_cache && Date.now() - subscription_cache.cached_at < ONE_HOUR) {
    return subscription_cache;
  }

  try {
    const resp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    });

    if (resp.status === 401) return null;
    if (!resp.ok) return null;

    const user = await resp.json();

    const cache = {
      is_blocked:           user.is_blocked || false,
      subscription_message: user.subscription_message || null,
      subscription_status:  user.subscription_status,
      cached_at:            Date.now(),
    };

    await chrome.storage.local.set({ subscription_cache: cache });
    return cache;

  } catch (err) {
    console.error("Subscription check failed:", err);
    return null;
  }
}

function showSubscriptionOverlay(message_type) {
  const overlay = document.getElementById("subscriptionOverlay");
  const icon    = document.getElementById("overlayIcon");
  const title   = document.getElementById("overlayTitle");
  const message = document.getElementById("overlayMessage");

  if (!overlay) return;

  const content = {
    trial_expired: {
      icon:    "⏰",
      title:   "Your Free Trial Has Ended",
      message: "Your 14-day free trial has expired. Upgrade to a paid plan to continue generating video ads and posting to Facebook.",
    },
    past_due: {
      icon:    "💳",
      title:   "Payment Failed",
      message: "We couldn't process your last payment. Please update your payment method to restore access to DealersOrbit.",
    },
    cancelled: {
      icon:    "🔒",
      title:   "Subscription Cancelled",
      message: "Your DealersOrbit subscription has been cancelled. Reactivate your subscription to continue generating ads.",
    },
  };

  const c = content[message_type] || content["cancelled"];
  if (icon)    icon.textContent    = c.icon;
  if (title)   title.textContent   = c.title;
  if (message) message.textContent = c.message;

  overlay.style.display = "flex";

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    overlay.style.display = "none";
  });

  document.getElementById("settingsBackBtn")?.addEventListener("click", async () => {
    const subStatus = await checkSubscriptionStatus();
    if (subStatus?.is_blocked) {
      overlay.style.display = "flex";
    }
  });
}

// ── State ──────────────────────────────────────────────────────
let isLoggingIn = false;
let currentFbListing = null;
let userLanguage = 'en';
let queueInterval = null;
const fbGeneratingJobs = new Set(); // job IDs currently being processed for FB listing
let reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
let reviewVehicle = null;
let activeJobPolling = false;
let modalSelectedType = null;
let modalSelectedTheme = null;
let modalVehicle = null;
let modalSelectedOutroId = null;
let modalQueueItemId = null;
let savedScripts          = [];
let selectedSavedScript   = null;
let currentGeneratedPrompt = null;

// Onboarding state
let onboardingState = {
  step:              'welcome',
  cardSelector:      null,
  detailUrl:         null,
  scrapedData:       null,
  priceOptions:      [],
  selectedPrice:     null,
  photoSelector:     null,
  exteriorClicked:   null,
  interiorClicked:   null,
  validationResults: {},
  attemptCount:      0,
  configForNewCars:  false,
};

// ... rest of the file (all functions and event listeners)
// ... init() call stays at the very bottom

// Sold checker stat click
soldCheckerStat?.addEventListener("click", async () => {
  const modal = document.getElementById("soldModal");
  if (!modal) return;
  modal.style.display = "flex";

  // Attach close handler here so modal exists
  document.getElementById("closeSoldModal").onclick = () => {
    modal.style.display = "none";
  };

  await loadSoldModalContent();
});

// Dismiss sold listing (X button inside sold modal)
document.getElementById("soldModalContent")?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".clear-sold-btn");
  if (!btn) return;

  const listingId = btn.dataset.listingId;
  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  btn.textContent = "...";
  btn.disabled = true;

  try {
    const resp = await apiFetch(`${API_BASE}/listings/${listingId}/clear-sold`, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed");

    // Also clear from local sold_notifications
    const { sold_notifications = [] } = await chrome.storage.local.get("sold_notifications");
    await chrome.storage.local.set({
      sold_notifications: sold_notifications.filter(id => String(id) !== String(listingId)),
    });

    // Refresh modal content
    await loadSoldModalContent();
  } catch (err) {
    btn.textContent = "✕";
    btn.disabled = false;
    console.error("DealersOrbit: Failed to clear sold flag:", err);
  }
});


async function loadSoldModalContent() {
  const content = document.getElementById("soldModalContent");
  content.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center">
    🔍 Checking listings...</p>`;

  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    content.innerHTML = `<p style="color:#dc2626">Please sign in first.</p>`;
    return;
  }

  try {
    // Get listings from backend
    const resp = await apiFetch(`${API_BASE}/listings/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed");

    const listings = await resp.json();
    const posted = listings.filter(l => l.fb_posted);
    const sold = listings.filter(l => l.is_sold);
    const active = posted.filter(l => !l.is_sold);

    if (posted.length === 0) {
      content.innerHTML = `
        <p style="font-size:13px;color:#6b7280;text-align:center;padding:16px">
          No Facebook listings found yet.<br>
          Post a vehicle to Facebook first.
        </p>`;
      return;
    }

    // Trigger a fresh check via background script (runs in browser context — no IP blocking)
    if (active.length > 0) {
      await new Promise(resolve => chrome.runtime.sendMessage({ type: 'RUN_SOLD_CHECK' }, resolve));

      // Refresh listings so last_checked_at and is_sold are up to date
      const refreshResp = await apiFetch(`${API_BASE}/listings/`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (refreshResp.ok) {
        const refreshed = await refreshResp.json();
        content.innerHTML = renderSoldModalContent(refreshed);
        updateSoldStat(refreshed);
        return;
      }
    }

    content.innerHTML = renderSoldModalContent(listings);
    updateSoldStat(listings);

  } catch (err) {
    content.innerHTML = `<p style="color:#dc2626;font-size:13px">
      Failed to check listings. Please try again.</p>`;
  }
}

function renderSoldModalContent(listings) {
  const sold     = listings.filter(l => l.is_sold);
  const active   = listings.filter(l => l.fb_posted && !l.is_sold);
  const unchecked = listings.filter(l => l.fb_posted && !l.last_checked_at);

  let html = "";

  if (sold.length > 0) {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#dc2626;
                  text-transform:uppercase;margin-bottom:8px">
        🚨 Sold — Remove from Facebook (${sold.length})
      </div>`;
    sold.forEach(l => {
      const title = [l.year, l.make?.toUpperCase(), l.model].filter(Boolean).join(" ");
      const detectedDate = l.sold_detected_at
        ? new Date(l.sold_detected_at).toLocaleDateString()
        : "Recently";
      html += `<div class="recent-ad-card" style="border-left:3px solid #dc2626">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title}</div>
          <div class="recent-ad-meta">${l.price || ""} · Detected sold: ${detectedDate}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="recent-ad-sold">Sold</span>
          <button class="btn-small clear-sold-btn"
                  data-listing-id="${l.id}"
                  style="background:#6b7280;font-size:10px;padding:2px 6px"
                  title="Dismiss — I've removed this from Facebook">✕</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  if (active.length > 0) {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#16a34a;
                  text-transform:uppercase;margin-bottom:8px">
        ✓ Still Active (${active.length})
      </div>`;
    active.forEach(l => {
      const title = [l.year, l.make?.toUpperCase(), l.model].filter(Boolean).join(" ");
      const checkedDate = l.last_checked_at
        ? new Date(l.last_checked_at).toLocaleDateString()
        : "Not yet checked";
      html += `<div class="recent-ad-card" style="border-left:3px solid #16a34a">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title}</div>
          <div class="recent-ad-meta">${l.price || ""} · Last checked: ${checkedDate}</div>
        </div>
        <span style="color:#16a34a;font-size:11px;font-weight:600">Active</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (unchecked.length > 0) {
    html += `<div style="font-size:11px;color:#9ca3af;text-align:center;padding:8px">
      ${unchecked.length} listing(s) not yet checked — check again in a few minutes
    </div>`;
  }

  if (sold.length === 0 && active.length === 0) {
    html = `<p style="font-size:13px;color:#6b7280;text-align:center;padding:16px">
      No posted listings found. Post a vehicle to Facebook first.</p>`;
  }

  return html;
}

function updateSoldStat(listings) {
  const soldCount = listings.filter(l => l.is_sold).length;
  if (statSoldCount) {
    statSoldCount.textContent = soldCount > 0 ? soldCount : "✓";
  }
  if (soldCheckerStat) {
    soldCheckerStat.classList.toggle("has-sold", soldCount > 0);
  }
  // Clear badge if no sold
  if (soldCount === 0) {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Delegated click handler for job list — handles dynamically rendered cards
document.getElementById("jobList")?.addEventListener("click", async (e) => {
  // Generate Ad button
  const generateBtn = e.target.closest(".generate-btn");
  if (generateBtn && !generateBtn.disabled) {
    const vin = generateBtn.dataset.vin;
    const model = generateBtn.dataset.model;
    const queueItemId = generateBtn.dataset.queueItemId;

    const { pending_review_queue = [] } =
      await chrome.storage.local.get("pending_review_queue");

    const item = pending_review_queue.find(i =>
      (queueItemId && i.queue_item_id === queueItemId) ||
      (vin && i.vehicle?.vin === vin)
    );

    if (!item) return;

    reviewVehicle = item.vehicle;
    modalQueueItemId = item.queue_item_id || null;

    if (item.classified) {
      reviewPhotos = buildReviewPhotos(
        item.classified,
        item.photos_all || item.vehicle?.photos || [],
        item.blocked_photos || [],
        item.explicit_other || []
      );
    } else if (item.review_photos) {
      reviewPhotos = item.review_photos;
    } else {
      reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
    }

    console.log("DealersOrbit: reviewPhotos for modal:", {
      exterior: reviewPhotos.exterior?.length,
      interior: reviewPhotos.interior?.length,
      additional: reviewPhotos.additional?.length,
    });
    showGenerateModal(item.vehicle);
    return;
  }

  // Post to Marketplace button
  const postFbBtn = e.target.closest(".post-marketplace-btn");
  if (postFbBtn && !postFbBtn.disabled) {
    e.stopPropagation();
    const jobId = postFbBtn.dataset.jobId;
    const { queue = [] } = await chrome.storage.local.get("queue");
    const job = queue.find(j => j.id === jobId);
    if (!job) return;
    openMarketplaceModal(job);
    return;
  }

  // FB Post button
  const fbPostBtn = e.target.closest(".post-fb-post-btn");
  if (fbPostBtn && !fbPostBtn.disabled) {
    e.stopPropagation();
    const jobId = fbPostBtn.dataset.jobId;
    const { queue = [] } = await chrome.storage.local.get("queue");
    const job = queue.find(j => j.id === jobId);
    if (!job) return;
    openFbPostModal(job);
    return;
  }

  // Post to Groups button
  const postGroupsBtn = e.target.closest(".post-groups-btn");
  if (postGroupsBtn && !postGroupsBtn.disabled) {
    e.stopPropagation();
    const jobId = postGroupsBtn.dataset.jobId;
    const { queue = [] } = await chrome.storage.local.get("queue");
    const job = queue.find(j => j.id === jobId);
    if (!job) return;
    openFbPostModal(job, 'groups');
    return;
  }

  // Remove failed button
  const removeBtn = e.target.closest(".remove-failed-btn");
  if (removeBtn) {
    const jobId = removeBtn.dataset.jobId;
    const { queue = [] } = await chrome.storage.local.get("queue");
    await chrome.storage.local.set({ queue: queue.filter(j => j.id !== jobId) });
    renderQueue();
    return;
  }

  // Per-card clear button
  const clearBtn = e.target.closest(".clear-card-btn");
  if (clearBtn) {
    const card = clearBtn.closest(".job-card");
    if (!card) return;
    const type = card.dataset.type;
    const jobId = card.dataset.jobId;
    const vin = card.dataset.vin;
    const model = card.dataset.model;

    if (type === "review") {
      const { pending_review_queue = [] } = await chrome.storage.local.get("pending_review_queue");
      const updated = pending_review_queue.filter(i =>
        vin ? i.vehicle?.vin !== vin : i.vehicle?.model !== model
      );
      await chrome.storage.local.set({ pending_review_queue: updated });
      chrome.action.setBadgeText({ text: updated.length > 0 ? String(updated.length) : "" });
    } else {
      const { queue = [] } = await chrome.storage.local.get("queue");
      await chrome.storage.local.set({ queue: queue.filter(j => j.id !== jobId) });
    }
    renderQueue();
    return;
  }

  // Card body click — open review screen
  const card = e.target.closest(".job-card");
  if (card && e.target.tagName !== "BUTTON" && e.target.tagName !== "A") {
    const type = card.dataset.type;
    const vin = card.dataset.vin;
    const model = card.dataset.model;
    const jobId = card.dataset.jobId;
    const queueItemId = card.dataset.queueItemId;

    if (type === "review") {
      const { pending_review_queue = [] } =
        await chrome.storage.local.get("pending_review_queue");
      // Match by queue_item_id first (exact), then VIN, never by model alone
      const item = pending_review_queue.find(i =>
        (queueItemId && i.queue_item_id === queueItemId) ||
        (vin && i.vehicle?.vin === vin)
      );
      if (item) {
        reviewVehicle = item.vehicle;
        reviewPhotos = item.review_photos || {
          exterior: item.classified?.exterior || [],
          interior: item.classified?.interior || [],
          additional: item.classified?.additional || [],
          other: item.classified?.other || [],
        };
        showReviewScreen(item);
      }
    } else if (type === "job") {
      // Show completed job photos
      const { queue = [] } = await chrome.storage.local.get("queue");
      const job = queue.find(j => j.id === jobId);
      if (!job) return;

      const photosForVideo = job.vehicle.photos_for_video || [];
      const allPhotos = job.vehicle.photos || [];
      const videoPhotoSet = new Set(photosForVideo);
      const remainingPhotos = allPhotos.filter(url => !videoPhotoSet.has(url));

      reviewVehicle = job.vehicle;
      reviewPhotos = {
        exterior: photosForVideo.slice(0, 6),
        interior: photosForVideo.slice(6, 8),
        additional: photosForVideo.slice(8),
        other: remainingPhotos,
      };

      showReviewScreen({
        vehicle: job.vehicle,
        photos_all: allPhotos,
        view_only: true,
        completed_job: job,
        classified: { exterior: photosForVideo.slice(0, 6), interior: photosForVideo.slice(6, 8), additional: photosForVideo.slice(8), other: [] },
        review_photos: reviewPhotos,
      });
    }
  }
});

settingsBackBtn?.addEventListener("click", () => showScreen(dashboardScreen));
helpBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://dealersorbit.com/help" });
});
siteBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://dealersorbit.com" });
});
signOutBtn?.addEventListener("click", async () => {
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
  await chrome.storage.local.remove([
    'token', 'user', 'subscription_cache',
    'pending_review_queue', 'queue',
    'fb_listing', 'fb_post', 'fb_groups_post', 'fb_posting_history',
    'sold_notifications', 'last_sold_check',
    'dealer_configured', 'config_status',
    'onboarding_card_selector', 'onboarding_detail_url',
    'onboarding_prices', 'onboarding_waiting_detail',
    'current_generating_vin', 'userLanguage', 'dealersorbit_migrated',
  ]);
  userInfo.style.display = "none";
  showScreen(loginScreen);
  console.log('DealersOrbit: Signed out, storage cleared');
});

// ── Onboarding ────────────────────────────────────────────────
const ADMIN_EMAILS = ['yoseph@jbakia.com', 'yosephfl@gmail.com'];

function showReviewBanner() {
  const banner = document.getElementById('reviewBanner');
  if (banner) banner.style.display = 'block';
}

async function checkAndStartOnboarding(user) {
  // Skip for admins
  if (ADMIN_EMAILS.includes(user?.email?.toLowerCase())) return;

  // Skip if already configured
  const { dealer_configured, config_status } =
    await chrome.storage.local.get(['dealer_configured', 'config_status']);
  if (dealer_configured) {
    if (config_status === 'pending_review') showReviewBanner();
    return;
  }

  // Skip if no dealership URL set
  if (!user?.dealership_url) return;

  showOnboardingStep('welcome');
}

function showOnboardingStep(stepName, data = {}) {
  onboardingState.step = stepName;
  const overlay  = document.getElementById('onboardingOverlay');
  const content  = document.getElementById('onboardingStepContent');
  const progress = document.getElementById('onboardingProgress');
  if (!overlay || !content) return;

  const steps = {
    'welcome':          0,
    'go_to_inventory':  15,
    'click_vehicle':    25,
    'go_to_detail':     35,
    'click_photos':     50,
    'select_price':     65,
    'validating':       75,
    'validation':       85,
    'new_car_prompt':   88,
    'new_car_go':       90,
    'new_car_detail':   93,
    'new_car_price':    96,
    'complete':         100,
    'manual_needed':    100,
  };

  if (progress) {
    progress.style.width = (steps[stepName] || 0) + '%';
  }

  overlay.style.display = 'flex';
  content.innerHTML = renderOnboardingStep(stepName, data);
  attachOnboardingHandlers(stepName, data);
}

function hideOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.style.display = 'none';
}

// Receive messages from content script / background during onboarding
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ONBOARDING_ON_DETAIL_PAGE') {
    showOnboardingStep('click_photos');
  }
  if (message.type === 'SHOW_PRICE_SELECTION') {
    showOnboardingStep('select_price', { prices: message.prices });
  }
});

function renderOnboardingStep(stepName, data = {}) {
  switch (stepName) {

    case 'welcome':
      return `
        <div style='text-align:center;margin-bottom:20px'>
          <div style='font-size:48px;margin-bottom:12px'>🚗</div>
          <h2 class='onboarding-step-title'>Let's set up your inventory</h2>
          <p class='onboarding-step-desc'>
            DealersOrbit needs to learn your dealership's website so it can
            import vehicles automatically. This takes about 2 minutes.
          </p>
        </div>
        <button class='onboarding-action-btn' id='onboardingStartBtn'>
          Get Started →
        </button>
        <button class='onboarding-skip-btn' id='onboardingSkipBtn'>
          Skip for now
        </button>`;

    case 'go_to_inventory':
      return `
        <div style='text-align:center;margin-bottom:16px'>
          <div style='font-size:36px;margin-bottom:10px'>📋</div>
          <h2 class='onboarding-step-title'>Go to your used car inventory</h2>
          <p class='onboarding-step-desc'>
            Open a new tab and navigate to your dealership's
            <strong>used car inventory page</strong> — the page that lists
            all your pre-owned vehicles.
          </p>
          <div style='
            background:#f0fdf4;
            border:1px solid #bbf7d0;
            border-radius:8px;
            padding:10px 12px;
            font-size:12px;
            color:#15803d;
            margin-bottom:16px;
            text-align:left;
          '>
            💡 Tip: This is usually a page like<br>
            <strong>yourdealer.com/used-inventory</strong>
          </div>
        </div>
        <button class='onboarding-action-btn' id='onboardingImOnInventoryBtn'>
          I'm on the inventory page ✓
        </button>
        <button class='onboarding-skip-btn' id='onboardingSkipBtn'>
          Skip for now
        </button>`;

    case 'click_vehicle':
      return `
        <div style='text-align:center;margin-bottom:16px'>
          <div style='font-size:36px;margin-bottom:10px'>👆</div>
          <h2 class='onboarding-step-title'>Click any vehicle</h2>
          <p class='onboarding-step-desc'>
            Click on any vehicle on the inventory page to open
            its detail page. DealersOrbit is watching and will
            learn from your click.
          </p>
          <div style='
            background:#f0fdf4;
            border:1px solid #bbf7d0;
            border-radius:8px;
            padding:10px 12px;
            font-size:12px;
            color:#15803d;
            text-align:left;
            margin-bottom:10px;
          '>
            💡 Pick a vehicle with <strong>real photos</strong> — not a
            new arrival with a stock image. The more photos it has, the
            better DealersOrbit will learn your site.
          </div>
          <div style='
            background:#eff6ff;
            border:1px solid #bfdbfe;
            border-radius:8px;
            padding:10px 12px;
            font-size:12px;
            color:#1e40af;
            text-align:left;
          '>
            🔍 DealersOrbit is ready and watching...
          </div>
        </div>
        <button class='onboarding-skip-btn' id='onboardingSkipBtn'>
          Skip for now
        </button>`;

    case 'click_photos':
      return `
        <div style='text-align:center;margin-bottom:16px'>
          <div style='font-size:36px;margin-bottom:10px'>📸</div>
          <h2 class='onboarding-step-title'>Click one exterior photo</h2>
          <p class='onboarding-step-desc'>
            On the vehicle detail page, click on any
            <strong>exterior photo</strong> of the car.
          </p>
          <div id='photoClickStatus' style='
            background:#eff6ff;
            border:1px solid #bfdbfe;
            border-radius:8px;
            padding:10px 12px;
            font-size:12px;
            color:#1e40af;
            text-align:left;
          '>
            🔍 Waiting for you to click an exterior photo...
          </div>
        </div>
        <button class='onboarding-skip-btn' id='onboardingSkipPhotosBtn'>
          Skip photo selection
        </button>`;

    case 'select_price': {
      const isNewCar = onboardingState.configForNewCars;
      const title = isNewCar
        ? 'Which price do you advertise for new cars?'
        : 'Which price does your dealership advertise?';
      const subtitle = isNewCar
        ? 'New cars often show MSRP, dealer discount, rebates, and incentives. Select the final price your dealership uses in ads.'
        : 'We found these prices on the vehicle page. Select the one your dealership uses in advertisements.';
      const prices = data.prices || [];
      const priceRows = prices.map((p, i) => `
        <div class='onboarding-price-option' data-price-index='${i}'>
          <div style='flex:1'>
            <div class='onboarding-price-label'>${p.label || 'Price'}</div>
            <div class='onboarding-price-value'>${p.value}</div>
          </div>
          <div style='font-size:20px'>○</div>
        </div>
      `).join('');
      return `
        <h2 class='onboarding-step-title'>${title}</h2>
        <p class='onboarding-step-desc'>${subtitle}</p>
        <div style='max-height:220px;overflow-y:auto;margin-bottom:16px'>
          ${priceRows || '<p style="color:#9ca3af;font-size:13px">No prices found — we\'ll use the best available</p>'}
        </div>
        <button class='onboarding-action-btn' id='onboardingConfirmPriceBtn' disabled>
          Confirm Price →
        </button>
        <button class='onboarding-skip-btn' id='onboardingSkipPriceBtn'>
          Not sure — use best guess
        </button>`;
    }

    case 'validating':
      return `
        <div style='text-align:center;padding:20px 0'>
          <div style='font-size:48px;margin-bottom:16px'>⚙️</div>
          <h2 class='onboarding-step-title'>Learning your site...</h2>
          <p class='onboarding-step-desc'>
            DealersOrbit is analyzing the vehicle data
            and building your configuration.
          </p>
          <div style='
            display:flex;
            align-items:center;
            gap:8px;
            justify-content:center;
            color:#1a56db;
            font-size:13px;
          '>
            <div style='
              width:16px;height:16px;
              border:2px solid #1a56db;
              border-top-color:transparent;
              border-radius:50%;
              animation:spin360 1s linear infinite;
            '></div>
            Analyzing...
          </div>
        </div>`;

    case 'validation': {
      const fields = data.fields || [];
      const rows = fields.map(f => `
        <div class='onboarding-field-row'>
          <div class='onboarding-field-label'>${f.label}</div>
          <div class='onboarding-field-value' title='${f.value || ''}'>${f.value || '—'}</div>
          <div class='onboarding-field-status' data-field='${f.key}'>
            ${f.value ? '✅' : '❓'}
          </div>
          ${f.value ? `
            <button class='onboarding-wrong-btn' data-field='${f.key}'
                    style='font-size:11px;background:none;border:1px solid #e5e7eb;
                           border-radius:4px;padding:3px 8px;cursor:pointer;color:#6b7280'>
              Wrong
            </button>` : ''}
        </div>
      `).join('');
      return `
        <h2 class='onboarding-step-title'>Does this look right?</h2>
        <p class='onboarding-step-desc'>
          We scraped this vehicle. Check that the details are correct.
        </p>
        <div style='margin-bottom:16px'>${rows}</div>
        <button class='onboarding-action-btn' id='onboardingValidationOkBtn'>
          Looks good! →
        </button>
        <button class='onboarding-skip-btn' id='onboardingSkipBtn'>
          Something is wrong — skip for now
        </button>`;
    }

    case 'new_car_prompt':
      return `
        <div style='text-align:center;margin-bottom:16px'>
          <div style='font-size:36px;margin-bottom:10px'>✨</div>
          <h2 class='onboarding-step-title'>Used cars ✓ Now let's do new cars</h2>
          <p class='onboarding-step-desc'>
            Great! Your used car inventory is configured.
            Now navigate to your <strong>new car inventory page</strong>
            so we can set that up too.
          </p>
          <p style='font-size:12px;color:#9ca3af'>
            New cars have different pricing (MSRP, rebates, dealer discount)
            so we need to set them up separately.
          </p>
        </div>
        <button class='onboarding-action-btn' id='onboardingDoNewCarsBtn'>
          Set Up New Cars →
        </button>
        <button class='onboarding-skip-btn' id='onboardingSkipNewCarsBtn'>
          Skip — I only sell used cars
        </button>`;

    case 'complete':
      return `
        <div style='text-align:center;padding:10px 0'>
          <div style='font-size:48px;margin-bottom:16px'>🎉</div>
          <h2 class='onboarding-step-title'>You're all set!</h2>
          <p class='onboarding-step-desc'>
            DealersOrbit has learned your inventory site.
            ${data.pendingReview ?
              'Your configuration is being reviewed and will be active within 24 hours.' :
              'Import buttons will appear on your vehicle listings right away.'}
          </p>
        </div>
        <button class='onboarding-action-btn' id='onboardingDoneBtn'>
          Start Importing Vehicles →
        </button>`;

    case 'manual_needed':
      return `
        <div style='text-align:center;padding:10px 0'>
          <div style='font-size:48px;margin-bottom:16px'>🛠️</div>
          <h2 class='onboarding-step-title'>Your site needs manual setup</h2>
          <p class='onboarding-step-desc'>
            Your dealership's website has a unique structure that
            requires manual configuration. Our team will set it up
            for you within <strong>24 hours</strong>.
          </p>
          <p style='font-size:12px;color:#9ca3af;margin-bottom:16px'>
            You'll receive an email when your configuration is ready.
          </p>
        </div>
        <button class='onboarding-action-btn' id='onboardingDoneBtn'>
          OK, got it
        </button>`;

    default:
      return '<p style="color:#9ca3af;font-size:13px;text-align:center">Loading...</p>';
  }
}

function attachOnboardingHandlers(stepName, data = {}) {
  // Universal skip handler
  document.getElementById('onboardingSkipBtn')?.addEventListener('click', async () => {
    hideOnboarding();
    await chrome.storage.local.set({ dealer_configured: true });
  });

  switch (stepName) {

    case 'welcome':
      document.getElementById('onboardingStartBtn')?.addEventListener('click', () => {
        showOnboardingStep('go_to_inventory');
      });
      break;

    case 'go_to_inventory':
      document.getElementById('onboardingImOnInventoryBtn')?.addEventListener('click', async () => {
        const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
        const activeTab = tabs.find(t => t.active) || tabs[0];
        if (!activeTab) {
          alert('Please open your inventory page in a browser tab first.');
          return;
        }
        try {
          await chrome.tabs.sendMessage(activeTab.id, { type: 'START_CARD_DETECTION' });
        } catch (e) {
          // Content script may not be injected on this page yet — advance anyway
          console.log('[Onboarding] START_CARD_DETECTION send failed:', e.message);
        }
        showOnboardingStep('click_vehicle');
      });
      break;

    case 'click_vehicle':
      // Content script messages us when a card is clicked — handled in chrome.runtime.onMessage
      break;

    case 'click_photos':
      document.getElementById('onboardingSkipPhotosBtn')?.addEventListener('click', () => {
        onboardingState.photoSelector = null;
        // TODO Phase 5: proceedToPriceSelection()
      });
      break;

    case 'select_price':
      document.querySelectorAll('.onboarding-price-option').forEach((option, idx) => {
        option.addEventListener('click', () => {
          document.querySelectorAll('.onboarding-price-option').forEach(o => {
            o.classList.remove('selected');
            o.querySelector('div:last-child').textContent = '○';
          });
          option.classList.add('selected');
          option.querySelector('div:last-child').textContent = '●';
          onboardingState.selectedPrice = data.prices[idx];
          const confirmBtn = document.getElementById('onboardingConfirmPriceBtn');
          if (confirmBtn) confirmBtn.disabled = false;
        });
      });

      document.getElementById('onboardingConfirmPriceBtn')?.addEventListener('click', async () => {
        await submitOnboardingConfig();
      });

      document.getElementById('onboardingSkipPriceBtn')?.addEventListener('click', async () => {
        onboardingState.selectedPrice = data.prices?.[0] || null;
        await submitOnboardingConfig();
      });
      break;

    case 'validation': {
      let wrongCount = 0;

      document.getElementById('onboardingValidationOkBtn')?.addEventListener('click', () => {
        if (onboardingState.configForNewCars) {
          finishOnboarding(true);
        } else {
          showOnboardingStep('new_car_prompt');
        }
      });

      document.querySelectorAll('.onboarding-wrong-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          wrongCount++;
          onboardingState.attemptCount++;
          const field    = btn.dataset.field;
          const statusEl = document.querySelector(`[data-field='${field}']`);
          if (statusEl) statusEl.textContent = '❌';
          btn.textContent = 'Marked';
          btn.disabled    = true;

          if (wrongCount >= 3 || onboardingState.attemptCount >= 5) {
            await chrome.runtime.sendMessage({ type: 'FLAG_FOR_MANUAL_REVIEW' });
            showOnboardingStep('manual_needed');
          }
        });
      });
      break;
    }

    case 'new_car_prompt':
      document.getElementById('onboardingDoNewCarsBtn')?.addEventListener('click', async () => {
        onboardingState.configForNewCars  = true;
        onboardingState.cardSelector      = null;
        onboardingState.detailUrl         = null;
        onboardingState.exteriorClicked   = null;
        onboardingState.interiorClicked   = null;
        onboardingState.selectedPrice     = null;
        await chrome.storage.local.remove([
          'onboarding_card_selector',
          'onboarding_detail_url',
          'onboarding_prices',
          'onboarding_waiting_detail',
        ]);
        showOnboardingStep('go_to_inventory');
      });
      document.getElementById('onboardingSkipNewCarsBtn')?.addEventListener('click', () => {
        finishOnboarding(true);
      });
      break;

    case 'complete':
    case 'manual_needed':
      document.getElementById('onboardingDoneBtn')?.addEventListener('click', async () => {
        hideOnboarding();
        await chrome.storage.local.set({ dealer_configured: true });
        const { config_status } = await chrome.storage.local.get('config_status');
        if (config_status === 'pending_review') showReviewBanner();
        renderQueue();
      });
      break;
  }
}

async function finishOnboarding(pendingReview = false) {
  await chrome.storage.local.remove([
    'onboarding_card_selector',
    'onboarding_detail_url',
    'onboarding_prices',
    'onboarding_waiting_detail',
  ]);
  await chrome.storage.local.set({
    dealer_configured: true,
    config_status: pendingReview ? 'pending_review' : 'active',
  });
  if (pendingReview) showReviewBanner();
  showOnboardingStep('complete', { pendingReview });
}

async function submitOnboardingConfig() {
  showOnboardingStep('validating');
  await new Promise(r => setTimeout(r, 50)); // let browser paint the spinner

  const { token } = await chrome.storage.local.get('token');

  try {
    const {
      onboarding_card_selector,
      onboarding_detail_url,
      onboarding_prices,
    } = await chrome.storage.local.get([
      'onboarding_card_selector',
      'onboarding_detail_url',
      'onboarding_prices',
    ]);

    // Find the detail page tab by matching stored URL (most reliable)
    const allTabs = await chrome.tabs.query({});
    let detailTab = null;
    if (onboarding_detail_url) {
      try {
        const stored = new URL(onboarding_detail_url);
        detailTab = allTabs.find(t => {
          try {
            const tu = new URL(t.url || '');
            return tu.hostname === stored.hostname && tu.pathname === stored.pathname;
          } catch (_) { return false; }
        });
      } catch (_) {}
    }
    // Fallback: active tab in last focused window
    if (!detailTab) {
      const winTabs = await chrome.tabs.query({ lastFocusedWindow: true });
      detailTab = winTabs.find(t => t.active);
    }

    // Capture price/spec/gallery HTML fragments from the detail page
    let detailHtml = null;
    if (detailTab) {
      try {
        const htmlResults = await chrome.scripting.executeScript({
          target: { tabId: detailTab.id },
          func:   captureDetailHtmlFragments,
        });
        detailHtml = htmlResults?.[0]?.result || null;
      } catch (e) {
        console.log('[Onboarding] captureDetailHtml failed:', e.message);
      }
    }

    // Build payload — card_selector and selected_price come from user interaction
    const payload = {
      source_url:              onboarding_detail_url || detailTab?.url || '',
      card_selector:           onboarding_card_selector,
      selected_price:          onboardingState.selectedPrice,
      exterior_photo_selector: onboardingState.exteriorClicked?.selector || null,
      interior_photo_selector: onboardingState.interiorClicked?.selector || null,
      detail_html:             detailHtml,
      for_new_cars:            onboardingState.configForNewCars,
    };

    const resp = await fetch(`${API_BASE}/dealer-configs/generate-from-html`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    // 409 = active config already exists — store it locally so buttons appear immediately
    if (resp.status === 409) {
      try {
        const errData = await resp.json();
        const existingConfig = errData?.detail?.config;
        if (existingConfig && onboarding_detail_url) {
          const srcDomain = new URL(onboarding_detail_url).hostname;
          await chrome.storage.local.set({
            onboarding_pending_config: {
              config:      existingConfig,
              domain:      srcDomain,
              price_label: onboardingState.selectedPrice?.label || null,
            },
          });
        }
      } catch (_) {}
      await finishOnboarding(false);
      return;
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Config generation failed (${resp.status}): ${errBody}`);
    }

    const configData = await resp.json();
    await chrome.storage.local.set({ onboarding_config_id: configData.config_id });

    // Store config locally so import buttons work immediately (without waiting for approval)
    if (configData.config) {
      try {
        const srcDomain = new URL(onboarding_detail_url || '').hostname;
        await chrome.storage.local.set({
          onboarding_pending_config: {
            config:       configData.config,
            domain:       srcDomain,
            price_label:  onboardingState.selectedPrice?.label || null,
          },
        });
      } catch (_) {}
    }

    // Validate by scraping the detail tab with the returned config
    let scrapeResult = {};
    if (detailTab && configData.config) {
      try {
        const scrapeResults = await chrome.scripting.executeScript({
          target: { tabId: detailTab.id },
          func:   scrapeVehicleForValidation,
          args:   [configData.config.detail_page || {}],
        });
        scrapeResult = scrapeResults?.[0]?.result || {};
      } catch (e) {
        console.log('[Onboarding] scrape validation failed:', e.message);
      }
    }

    // If user picked a price, trust that over what we scraped
    const displayPrice = onboardingState.selectedPrice?.value || scrapeResult.price || null;

    showOnboardingStep('validation', {
      fields: [
        { key: 'title',  label: 'Vehicle',  value: scrapeResult.rawTitle || null },
        { key: 'vin',    label: 'VIN',      value: scrapeResult.vin      || null },
        { key: 'price',  label: 'Price',    value: displayPrice                  },
        { key: 'photos', label: 'Photos',   value: scrapeResult.photoCount ? `${scrapeResult.photoCount} found` : null },
      ],
    });

  } catch (err) {
    console.error('[Onboarding] submitOnboardingConfig failed:', err);
    onboardingState.attemptCount++;
    if (onboardingState.attemptCount >= 5) {
      showOnboardingStep('manual_needed');
    } else {
      showOnboardingStep('validation', {
        fields: [],
        error:  err.message,
      });
    }
  }
}

// Standalone — serialized and injected into the detail page tab
function captureDetailHtmlFragments() {
  const tryCapture = (selectors, label) => {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return `<!-- ${label} -->\n${el.outerHTML.substring(0, 3000)}`;
      } catch (_) {}
    }
    return null;
  };

  const fragments = [
    tryCapture(['dl.pricing-detail', '#price-box', '.vdp-price-box', '.price-box',
                '.vehicle-pricing', '[class*="pricing"]'], 'PRICES'),
    tryCapture(['dl.dl-horizontal', '.basic-info-component', '.vehicle-details',
                '.specs-table', '[class*="spec"]', '.vehicle-info'], 'SPECS'),
    tryCapture(['.vdp-gallery', '.media-gallery', '[class*="gallery"]',
                '.vehicle-photos', '.photo-gallery'], 'GALLERY'),
  ].filter(Boolean);

  return fragments.join('\n\n');
}

// Standalone — serialized and injected into the detail page tab
function scrapeVehicleForValidation(selectors) {
  const safeQuery = (sel) => {
    try { return document.querySelector(sel)?.textContent?.trim() || null; }
    catch (_) { return null; }
  };

  const bodyText = document.body?.innerText || '';
  const title    = document.querySelector('h1')?.textContent?.trim() ||
                   document.title?.replace(/ [-|].*/, '') || '';

  // VIN — 17-char alphanum pattern in page text
  const vinMatch = bodyText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);

  // Price — from selector first, then any prominent price element
  let price = null;
  if (selectors?.sale_price) {
    const el = safeQuery(selectors.sale_price);
    if (el) { const m = el.match(/\$[\d,]+/); if (m) price = m[0]; }
  }
  if (!price) {
    const els = document.querySelectorAll('[class*="price"],[class*="Price"]');
    for (const el of els) {
      const m = el.textContent?.match(/\$[\d,]+/);
      if (m && parseInt(m[0].replace(/[$,]/g, '')) > 1000) { price = m[0]; break; }
    }
  }

  // Photos — count visible images larger than thumbnails
  const photoSel = selectors?.photos || 'img';
  let photoCount = 0;
  try {
    document.querySelectorAll(photoSel).forEach(img => {
      if ((img.naturalWidth || img.width) > 100) photoCount++;
    });
  } catch (_) {}

  return {
    rawTitle:   title.substring(0, 60),
    vin:        vinMatch?.[0] || null,
    price:      price,
    photoCount: photoCount,
  };
}

async function loadTaglineSettings() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  try {
    const resp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const user = await resp.json();

    const lockedDisplay = document.getElementById("lockedTaglineDisplay");
    const customDisplay = document.getElementById("customTaglineDisplay");
    const lockedText    = document.getElementById("lockedTaglineText");
    const customInput   = document.getElementById("customTaglineInput");

    const isSpanish     = userLanguage === 'es';
    const lockedTagline = isSpanish
      ? user.dealership_required_tagline_es
      : user.dealership_required_tagline;
    const customTagline = isSpanish
      ? user.custom_tagline_es
      : user.custom_tagline;

    if (lockedTagline) {
      if (lockedDisplay) lockedDisplay.style.display = "block";
      if (customDisplay) customDisplay.style.display = "none";
      if (lockedText)    lockedText.textContent = lockedTagline;
    } else {
      if (lockedDisplay) lockedDisplay.style.display = "none";
      if (customDisplay) customDisplay.style.display = "block";
      if (customInput)   customInput.value = customTagline || '';
      if (customInput)   customInput.placeholder = isSpanish
        ? 'ej. Sin cargos adicionales del distribuidor'
        : 'e.g. No additional dealer fees';
    }
  } catch (err) {
    console.error("Could not load tagline settings:", err);
  }
}

async function autoTranslateTagline() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) return;

  const meResp = await fetch(`${API_BASE}/auth/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!meResp.ok) return;
  const user = await meResp.json();

  // Use English tagline as source
  const englishTagline = user.custom_tagline || user.dealership_required_tagline || '';
  if (!englishTagline) return;

  // If a Spanish tagline already exists, show it without overwriting
  const existingEs = user.custom_tagline_es || user.dealership_required_tagline_es;

  const customInput = document.getElementById('customTaglineInput');
  if (!customInput) return;

  if (existingEs) {
    customInput.value = existingEs;
    return;
  }

  customInput.placeholder = 'Translating...';
  customInput.disabled    = true;

  try {
    const resp = await fetch(`${API_BASE}/listings/translate-tagline`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ text: englishTagline, target_language: 'es' }),
    });
    if (!resp.ok) throw new Error('Translation failed');
    const data = await resp.json();

    customInput.value = data.translated;

    // Auto-save the translation
    await fetch(`${API_BASE}/auth/me`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ custom_tagline_es: data.translated }),
    });

    const { user: storedUser = {} } = await chrome.storage.local.get('user');
    storedUser.custom_tagline_es = data.translated;
    await chrome.storage.local.set({ user: storedUser });

  } catch (err) {
    console.error('Auto-translate failed:', err);
  } finally {
    customInput.disabled    = false;
    customInput.placeholder = 'ej. Sin cargos adicionales del distribuidor';
  }
}

document.getElementById("saveTaglineBtn")?.addEventListener("click", async () => {
  const saveBtn  = document.getElementById("saveTaglineBtn");
  const savedMsg = document.getElementById("taglineSaved");
  const tagline  = document.getElementById("customTaglineInput")?.value.trim();

  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving...";

  try {
    const { token } = await chrome.storage.local.get("token");
    const taglineField = userLanguage === 'es' ? 'custom_tagline_es' : 'custom_tagline';
    const resp = await fetch(`${API_BASE}/auth/me`, {
      method:  "PATCH",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ [taglineField]: tagline || null }),
    });

    if (!resp.ok) throw new Error("Save failed");

    if (savedMsg) {
      savedMsg.style.display = "block";
      setTimeout(() => savedMsg.style.display = "none", 2000);
    }
  } catch (err) {
    alert("Failed to save tagline. Please try again.");
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = "Save Tagline";
  }
});

// Settings screen populate
async function showSettingsScreen() {
  const { user } = await chrome.storage.local.get("user");
  if (user) {
    document.getElementById("settingsEmail").textContent = user.email || "";
    document.getElementById("settingsDealership").textContent = user.dealership_name || "";
    document.getElementById("phoneInput").value = user.phone_number || "";
  }
  showScreen(settingsScreen);
  // Sync language buttons to current state
  document.querySelectorAll('.lang-btn').forEach(b => {
    const isSelected = b.dataset.lang === userLanguage;
    b.classList.toggle('selected', isSelected);
    b.style.borderColor = isSelected ? '#1a56db' : '#e5e7eb';
    b.style.background  = isSelected ? '#eff6ff' : 'white';
    b.style.color       = isSelected ? '#1a56db' : '#374151';
  });
  loadOutroSettings();
  loadVoiceSettings();
  loadTaglineSettings();
}

settingsBtn?.addEventListener("click", showSettingsScreen);

document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
  const { token } = await chrome.storage.local.get("token");
  const phone = document.getElementById("phoneInput")?.value.trim();

  const resp = await apiFetch(`${API_BASE}/auth/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      phone_number: phone || null,
    }),
  });

  if (resp.ok) {
    const updated = await resp.json();
    await chrome.storage.local.set({ user: updated });
    document.getElementById("settingsSaved").style.display = "block";
    setTimeout(() => {
      document.getElementById("settingsSaved").style.display = "none";
    }, 2000);
  }
});


document.getElementById("saveVoiceBtn")?.addEventListener("click", async () => {
  const saveBtn  = document.getElementById("saveVoiceBtn");
  const savedMsg = document.getElementById("voiceSaved");

  const voiceIdToSave = selectedVoiceId;
  if (!voiceIdToSave) {
    alert("Please select a voice or enter your voice ID.");
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving...";

  try {
    const { token } = await chrome.storage.local.get("token");
    const voiceField = userLanguage === 'es' ? 'elevenlabs_voice_id_es' : 'elevenlabs_voice_id';
    const resp = await apiFetch(`${API_BASE}/auth/me`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ [voiceField]: voiceIdToSave }),
    });

    if (!resp.ok) throw new Error("Save failed");

    const updated = await resp.json();
    await chrome.storage.local.set({ user: updated });

    // Persist custom voice ID locally (English only)
    if (userLanguage !== 'es' && !PRELOADED_VOICES.find(v => v.id === voiceIdToSave)) {
      customVoiceId = voiceIdToSave;
      await chrome.storage.local.set({ custom_voice_id: voiceIdToSave });
    }

    if (savedMsg) {
      savedMsg.style.display = "block";
      setTimeout(() => { savedMsg.style.display = "none"; }, 2000);
    }

    const voices = userLanguage === 'es' ? SPANISH_VOICES : PRELOADED_VOICES;
    renderVoiceList(voices, voiceIdToSave);
  } catch (err) {
    alert("Failed to save. Please try again.");
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = "Save Voice Settings";
  }
});

document.getElementById("voiceIdInput")?.addEventListener("input", (e) => {
  const val      = e.target.value.trim();
  const statusEl = document.getElementById("myVoiceStatus");
  if (val) {
    customVoiceId   = val;
    selectedVoiceId = val;
    if (statusEl) statusEl.style.display = "block";
    renderVoiceList();
  } else {
    customVoiceId = null;
    // Revert selection to Brian default if nothing else is selected
    if (!PRELOADED_VOICES.find(v => v.id === selectedVoiceId)) {
      selectedVoiceId = 'Gubgw9l4dtIoQA9YZHgx';
    }
    if (statusEl) statusEl.style.display = "none";
    renderVoiceList();
  }
});

// ── Voice settings ────────────────────────────────────────────
let selectedVoiceId  = 'Gubgw9l4dtIoQA9YZHgx'; // Brian default
let customVoiceId    = null;                     // user's cloned voice ID, persisted separately
let voicePreviewUrls = {};
let currentAudio     = null;

const PRELOADED_VOICES = [
  { id: 'Gubgw9l4dtIoQA9YZHgx', name: 'Brian',   desc: 'Deep and Comforting',    default: true },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel',  desc: 'Steady Broadcaster' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura',   desc: 'Narration Voice' },
  { id: 'OYTbf65OHHFELVut7v2H', name: 'Hope',    desc: 'Natural and Clear' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',    desc: 'Engaging and Firm' },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric',    desc: 'Smooth, Trustworthy' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam',    desc: 'Energetic' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George',  desc: 'Warm, Captivating' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', desc: 'Deep and Confident' },
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will',    desc: 'Relaxed Optimist' },
  { id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill',    desc: 'Wise and Mature' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris',   desc: 'Charming, Down-to-Earth' },
];

const SPANISH_VOICES = [
  { id: 'zDMHo7CPscBTgfDtPOWl', name: 'Claus',     desc: 'Natural Spanish',        default: true },
  { id: 'G4IAP30yc6c1gK0csDfu', name: 'Juan',      desc: 'Warm and Conversational' },
  { id: 'k8cFOyAg7B9qwBlDDNTC', name: 'Miguel',    desc: 'Clear and Confident' },
  { id: '9F4C8ztpNUmXkdDDbz3J', name: 'Dan',       desc: 'Professional' },
  { id: '8mBRP99B2Ng2QwsJMFQl', name: 'El Faraon', desc: 'Deep and Powerful' },
  { id: '22VndfJPBU7AZORAZZTT', name: 'Valeria',   desc: 'Bright and Energetic' },
  { id: 'iqH5zmD4xxyGBHUsZ4Gt', name: 'Lis',       desc: 'Warm and Natural' },
];

async function loadVoiceSettings() {
  const { token, user, custom_voice_id } = await chrome.storage.local.get(['token', 'user', 'custom_voice_id']);
  if (!token) return;

  const isSpanish = userLanguage === 'es';
  const voices    = isSpanish ? SPANISH_VOICES : PRELOADED_VOICES;

  const currentVoiceId = isSpanish
    ? (user?.elevenlabs_voice_id_es || 'zDMHo7CPscBTgfDtPOWl')
    : (user?.elevenlabs_voice_id    || 'Gubgw9l4dtIoQA9YZHgx');

  selectedVoiceId = currentVoiceId;

  // customVoiceId only applies to English (cloned voice)
  if (!isSpanish) {
    const savedIsCustom = selectedVoiceId && !PRELOADED_VOICES.find(v => v.id === selectedVoiceId);
    customVoiceId = savedIsCustom ? selectedVoiceId : (custom_voice_id || null);
  } else {
    customVoiceId = null;
  }

  try {
    const resp = await apiFetch(`${API_BASE}/auth/voices/preloaded`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (resp.ok) {
      const data       = await resp.json();
      voicePreviewUrls = data.preview_urls || {};
    }
  } catch (err) {
    console.log('Could not load voice previews:', err);
  }

  renderVoiceList(voices, currentVoiceId);
}

function renderVoiceList(voices = PRELOADED_VOICES, currentVoiceId = null) {
  const container = document.getElementById('voiceDropdownContainer');
  if (!container) return;

  const activeId = currentVoiceId || selectedVoiceId;

  // Build select options
  let options = voices.map(v =>
    `<option value="${v.id}" ${activeId === v.id ? 'selected' : ''}>${v.name} — ${v.desc}</option>`
  ).join('');

  if (customVoiceId && userLanguage !== 'es') {
    options += `<option value="${customVoiceId}" ${activeId === customVoiceId ? 'selected' : ''}>🎤 My Voice — Your cloned voice</option>`;
  }

  const initialHasPreview = !!voicePreviewUrls[activeId];
  container.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">
      <select id="voiceSelect" style="flex:1;font-size:13px;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;background:white;color:#111827;cursor:pointer">
        ${options}
      </select>
      <button id="voicePreviewBtn" title="${initialHasPreview ? 'Preview selected voice' : 'No preview available'}"
              ${initialHasPreview ? '' : 'disabled'}
              style="flex-shrink:0;background:none;border:1px solid ${initialHasPreview ? '#d1d5db' : '#e5e7eb'};border-radius:6px;padding:6px 10px;font-size:16px;cursor:${initialHasPreview ? 'pointer' : 'default'};color:${initialHasPreview ? '#6b7280' : '#d1d5db'};transition:color 0.15s,border-color 0.15s">▶️</button>
    </div>`;

  const select = container.querySelector('#voiceSelect');
  const previewBtn = container.querySelector('#voicePreviewBtn');

  select.addEventListener('change', () => {
    selectedVoiceId = select.value;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      previewBtn.textContent = '▶️';
    }
    const hasPreview = !!voicePreviewUrls[selectedVoiceId];
    previewBtn.disabled       = !hasPreview;
    previewBtn.title          = hasPreview ? 'Preview selected voice' : 'No preview available';
    previewBtn.style.cursor   = hasPreview ? 'pointer' : 'default';
    previewBtn.style.color    = hasPreview ? '#6b7280' : '#d1d5db';
    previewBtn.style.borderColor = hasPreview ? '#d1d5db' : '#e5e7eb';
  });

  previewBtn.addEventListener('click', () => {
    const previewUrl = voicePreviewUrls[selectedVoiceId];

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      previewBtn.textContent = '▶️';
      previewBtn.classList.remove('playing');
      if (!previewUrl) return;
    }

    if (!previewUrl) return;

    previewBtn.textContent = '⏸️';
    previewBtn.classList.add('playing');
    previewBtn.style.color = '#1a56db';
    previewBtn.style.borderColor = '#1a56db';

    currentAudio = new Audio(previewUrl);
    currentAudio.play();
    currentAudio.onended = () => {
      previewBtn.textContent = '▶️';
      previewBtn.classList.remove('playing');
      previewBtn.style.color = '#6b7280';
      previewBtn.style.borderColor = '#d1d5db';
      currentAudio = null;
    };
    currentAudio.onerror = () => {
      previewBtn.textContent = '▶️';
      previewBtn.classList.remove('playing');
      previewBtn.style.color = '#6b7280';
      previewBtn.style.borderColor = '#d1d5db';
      currentAudio = null;
    };
  });

  // Keep own-voice input in sync with customVoiceId
  const voiceIdInput = document.getElementById('voiceIdInput');
  const statusEl     = document.getElementById('myVoiceStatus');
  if (voiceIdInput) voiceIdInput.value = customVoiceId || '';
  if (statusEl) statusEl.style.display = customVoiceId ? 'block' : 'none';
}

// ── Outro settings ────────────────────────────────────────────
async function loadOutroSettings() {
  const list = document.getElementById("outroSettingsList");
  if (!list) return;
  list.innerHTML = `<p style="color:#9ca3af;font-size:12px;text-align:center;padding:8px">Loading...</p>`;

  const { token } = await chrome.storage.local.get("token");
  try {
    const resp = await apiFetch(`${API_BASE}/outros/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed");
    const outros = await resp.json();

    if (outros.length === 0) {
      list.innerHTML = `<p style="color:#9ca3af;font-size:12px;text-align:center;padding:8px">No outro videos yet.</p>`;
      return;
    }

    list.innerHTML = outros.map(o => `
      <div class="outro-saved-item">
        <span class="outro-saved-name">${o.name}</span>
        <div class="outro-saved-actions">
          <a href="${o.url}" target="_blank" class="btn-small">Preview</a>
          <button class="btn-small outro-delete-btn" data-id="${o.id}"
                  style="background:#fee2e2;color:#dc2626">Delete</button>
        </div>
      </div>`).join("");

  } catch (err) {
    if (err.message === "session_expired") return;
    list.innerHTML = `<p style="color:#dc2626;font-size:12px">Failed to load. Please try again.</p>`;
  }
}

document.getElementById("uploadOutroBtn")?.addEventListener("click", async () => {
  const fileInput = document.getElementById("outroFileInput");
  const nameInput = document.getElementById("outroNameInput");
  const statusEl = document.getElementById("outroUploadStatus");
  const btn = document.getElementById("uploadOutroBtn");

  const file = fileInput?.files?.[0];
  const name = nameInput?.value.trim();

  if (!name) {
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Please enter a name for this outro.";
    return;
  }
  if (!file) {
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Please select a video file.";
    return;
  }

  btn.textContent = "Uploading...";
  btn.disabled = true;
  statusEl.style.display = "none";

  try {
    const { token } = await chrome.storage.local.get("token");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("name", name);

    const resp = await apiFetch(`${API_BASE}/outros/upload`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Upload failed");
    }

    fileInput.value = "";
    nameInput.value = "";
    statusEl.style.display = "block";
    statusEl.style.color = "#16a34a";
    statusEl.textContent = "✓ Uploaded!";
    setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    await loadOutroSettings();

  } catch (err) {
    if (err.message === "session_expired") return;
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = err.message || "Upload failed. Please try again.";
  } finally {
    btn.textContent = "+ Upload Outro";
    btn.disabled = false;
  }
});

document.getElementById("outroSettingsList")?.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest(".outro-delete-btn");
  if (!deleteBtn) return;

  const outroId = deleteBtn.dataset.id;
  deleteBtn.textContent = "Deleting...";
  deleteBtn.disabled = true;

  try {
    const { token } = await chrome.storage.local.get("token");
    const resp = await apiFetch(`${API_BASE}/outros/${outroId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok && resp.status !== 204) throw new Error("Delete failed");
    await loadOutroSettings();
  } catch (err) {
    if (err.message === "session_expired") return;
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = false;
  }
});

// Copy button handlers — work for any btn-copy button
document.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("btn-copy")) return;
  const targetId = e.target.dataset.target;
  const el = document.getElementById(targetId);
  if (!el) return;

  await navigator.clipboard.writeText(el.textContent);
  e.target.textContent = "Copied!";
  e.target.classList.add("copied");
  setTimeout(() => {
    e.target.textContent = "Copy";
    e.target.classList.remove("copied");
  }, 2000);
});


backBtn.addEventListener("click", async () => {
  // Don't remove pending_review — just go back to queue
  // User can return to review by clicking the extension icon
  chrome.action.setBadgeText({ text: "!" });  // keep badge to remind them
  showScreen(dashboardScreen);
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

fbBackBtn.addEventListener("click", () => {
  showScreen(reviewScreen);
});

// ── FB Post Modal ─────────────────────────────────────────────
let fbPostModalJob = null;
let fbPostSelectedPhotos = new Set();
let fbPostCurrentTheme = 'hype';
let fbPostModalMode = 'post';

function openFbPostModal(job, mode = 'post') {
  fbPostModalJob = job;
  fbPostModalMode = mode;
  fbPostSelectedPhotos = new Set();
  fbPostCurrentTheme = 'hype';

  const modal = document.getElementById('fbPostModal');
  if (!modal) return;

  const v = job.vehicle || {};

  // Build photo list ordered: exterior → interior → additional → unclassified
  // vehicle.photos_exterior/interior are the classified buckets saved at review time
  // vehicle.photos_for_video is the curated selection (ext + int + additional)
  // vehicle.photos is the full scrape — unclassified = in photos but not in photos_for_video
  const parseArr = raw => Array.isArray(raw)
    ? raw
    : (() => { try { return JSON.parse(raw || '[]'); } catch { return []; } })();

  const exterior    = parseArr(v.photos_exterior);
  const interior    = parseArr(v.photos_interior);
  const forVideo    = parseArr(v.photos_for_video);
  const allOriginal = parseArr(v.photos || v.car_photo_urls || []);

  const extSet = new Set(exterior);
  const intSet = new Set(interior);
  const forVideoSet = new Set(forVideo);

  const additional    = forVideo.filter(url => !extSet.has(url) && !intSet.has(url));
  const unclassified  = allOriginal.filter(url => !forVideoSet.has(url));

  let allPhotos = [...exterior, ...interior, ...additional, ...unclassified];

  // Fallback if nothing came through
  if (allPhotos.length === 0) allPhotos = forVideo.length ? forVideo : allOriginal;

  // Pre-select first 6
  allPhotos.slice(0, 6).forEach(url => fbPostSelectedPhotos.add(url));

  // Render photo grid
  const grid = document.getElementById('fbPostPhotoGrid');
  if (grid) {
    grid.innerHTML = allPhotos.map((url, i) => {
      const sel = fbPostSelectedPhotos.has(url);
      const num = sel ? [...fbPostSelectedPhotos].indexOf(url) + 1 : '';
      return `<div class='fb-post-photo ${sel ? 'selected' : ''}' data-url='${url}' data-index='${i}'>
        <img src='${url}' loading='lazy' alt='Photo ${i + 1}'>
        <div class='photo-check'>✓</div>
        <div class='photo-num'>${num}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.fb-post-photo').forEach(photo => {
      photo.addEventListener('click', () => {
        const url = photo.dataset.url;
        if (fbPostSelectedPhotos.has(url)) {
          fbPostSelectedPhotos.delete(url);
        } else {
          fbPostSelectedPhotos.add(url);
        }
        updateFbPostSelectionUI();
      });
    });
  }

  // Reset theme buttons
  document.querySelectorAll('.fb-caption-theme-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.theme === 'hype');
  });

  updateFbPostSelectionUI();

  // Update title and submit button based on mode
  const modalTitle = modal.querySelector('.modal-title');
  if (modalTitle) {
    modalTitle.textContent = mode === 'groups'
      ? '👥 Post to Facebook Groups'
      : '📘 Create Facebook Post';
  }
  const submitBtn = document.getElementById('fbPostSubmitBtn');
  if (submitBtn) {
    submitBtn.textContent = mode === 'groups'
      ? '👥 Post to Groups'
      : '📘 Post to Facebook';
    submitBtn.disabled = false;
  }

  modal.style.display = 'flex';

  // Auto-generate caption with default theme
  generateFbPostCaption(job, fbPostCurrentTheme);
}

async function generateFbPostCaption(job, theme) {
  const loadingEl = document.getElementById('fbCaptionLoading');
  const captionEl = document.getElementById('fbPostCaption');
  if (!captionEl) return;

  if (loadingEl) loadingEl.style.display = 'block';
  captionEl.style.display = 'none';
  captionEl.value = '';

  try {
    const { token } = await chrome.storage.local.get('token');
    const v = job.vehicle || {};
    const res = await fetch(`${API_BASE}/listings/generate-fb-post-caption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        year:     v.year    || null,
        make:     v.make    || null,
        model:    v.model   || null,
        trim:     v.trim    || null,
        price:    v.price   || null,
        mileage:  v.mileage || null,
        theme,
        language: userLanguage,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      captionEl.value = data.caption || '';
    }
  } catch {
    // leave textarea empty — user can type manually
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    captionEl.style.display = 'block';
  }
}

function updateFbPostSelectionUI() {
  const countEl = document.getElementById('fbPostSelectedCount');
  if (countEl) countEl.textContent = fbPostSelectedPhotos.size;

  const grid = document.getElementById('fbPostPhotoGrid');
  if (!grid) return;

  let selIndex = 1;
  const selectedArr = [...fbPostSelectedPhotos];
  grid.querySelectorAll('.fb-post-photo').forEach(photo => {
    const url = photo.dataset.url;
    const numEl = photo.querySelector('.photo-num');
    if (fbPostSelectedPhotos.has(url)) {
      photo.classList.add('selected');
      if (numEl) numEl.textContent = selectedArr.indexOf(url) + 1;
    } else {
      photo.classList.remove('selected');
      if (numEl) numEl.textContent = '';
    }
  });
}

// Theme button handlers
document.querySelectorAll('.fb-caption-theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    fbPostCurrentTheme = btn.dataset.theme;
    document.querySelectorAll('.fb-caption-theme-btn').forEach(b =>
      b.classList.toggle('selected', b === btn)
    );
    if (fbPostModalJob) generateFbPostCaption(fbPostModalJob, fbPostCurrentTheme);
  });
});

// ── Marketplace Modal ─────────────────────────────────────────
let mpModalJob       = null;
let mpSelectedPhotos = new Set();
let mpCurrentTheme   = 'value';

function openMarketplaceModal(job) {
  mpModalJob       = job;
  mpSelectedPhotos = new Set();
  mpCurrentTheme   = 'value';

  const modal = document.getElementById('marketplaceModal');
  if (!modal) return;

  const allPhotos      = job.vehicle.photos || [];
  const photosForVideo = job.vehicle.photos_for_video || [];
  const ordered        = [
    ...photosForVideo,
    ...allPhotos.filter(p => !photosForVideo.includes(p)),
  ];

  ordered.slice(0, 20).forEach(url => mpSelectedPhotos.add(url));

  const grid = document.getElementById('mpPhotoGrid');
  if (grid) {
    grid.innerHTML = ordered.map((url, i) => {
      const isSelected = mpSelectedPhotos.has(url);
      return `<div class='fb-post-photo ${isSelected ? 'selected' : ''}'
                   data-url='${url}' data-mp-index='${i}'>
                <img src='${url}' loading='lazy' alt='Photo ${i + 1}'>
                <div class='photo-check'>✓</div>
                <div class='photo-num'>${isSelected ? i + 1 : ''}</div>
              </div>`;
    }).join('');

    grid.querySelectorAll('.fb-post-photo').forEach(photo => {
      photo.addEventListener('click', () => {
        const url = photo.dataset.url;
        if (mpSelectedPhotos.has(url)) {
          mpSelectedPhotos.delete(url);
        } else {
          if (mpSelectedPhotos.size >= 20) return;
          mpSelectedPhotos.add(url);
        }
        updateMpSelectionUI();
      });
    });
  }

  document.querySelectorAll('.mp-theme-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.theme === 'value');
  });

  updateMpSelectionUI();

  const descEl = document.getElementById('mpDescription');
  if (descEl) descEl.value = '';

  modal.style.display = 'flex';

  generateMarketplaceDescription('value');
}

function updateMpSelectionUI() {
  const countEl = document.getElementById('mpSelectedCount');
  if (countEl) countEl.textContent = mpSelectedPhotos.size;

  let selIndex = 1;
  document.querySelectorAll('#mpPhotoGrid .fb-post-photo').forEach(photo => {
    const url   = photo.dataset.url;
    const numEl = photo.querySelector('.photo-num');
    if (mpSelectedPhotos.has(url)) {
      photo.classList.add('selected');
      if (numEl) numEl.textContent = selIndex++;
    } else {
      photo.classList.remove('selected');
      if (numEl) numEl.textContent = '';
    }
  });
}

async function generateMarketplaceDescription(theme) {
  if (!mpModalJob) return;

  const loadingEl = document.getElementById('mpCaptionLoading');
  const descEl    = document.getElementById('mpDescription');

  if (loadingEl) loadingEl.style.display = 'block';
  if (descEl)    descEl.style.display    = 'none';

  try {
    const { token } = await chrome.storage.local.get('token');
    const v          = mpModalJob.vehicle;

    const resp = await fetch(`${API_BASE}/listings/generate`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        year:        v.year,
        make:        v.make,
        model:       v.model,
        trim:        v.trim,
        price:       v.advertised_price || v.price,
        mileage:     v.mileage,
        vin:         v.vin,
        listing_url: v.listing_url,
        theme:       theme,
        language:    userLanguage,
      }),
    });

    if (!resp.ok) throw new Error('Failed');
    const data = await resp.json();
    if (descEl) descEl.value = data.description || '';

  } catch (err) {
    console.error('DealersOrbit: MP description generation failed:', err);
    if (descEl) {
      const v     = mpModalJob.vehicle;
      const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
      descEl.value = `${title}\n${v.advertised_price || v.price || ''} · ${v.mileage || ''}\n\nDM me for more info!`;
    }
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (descEl)    descEl.style.display    = 'block';
  }
}

async function syncSoldNotificationsFromBackend() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) return;
  try {
    const resp = await apiFetch(`${API_BASE}/listings/`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) return;
    const listings = await resp.json();
    const soldIds = listings.filter(l => l.is_sold).map(l => l.id);
    if (soldIds.length > 0) {
      await chrome.storage.local.set({ sold_notifications: soldIds });
      chrome.action.setBadgeText({ text: '🔴' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else {
      await chrome.storage.local.remove('sold_notifications');
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    console.error('DealersOrbit: Could not sync sold notifications:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // ── Language toggle ──────────────────────────────────────────
  function updateLangBtnUI(lang) {
    document.querySelectorAll('.lang-btn').forEach(b => {
      const isSelected = b.dataset.lang === lang;
      b.classList.toggle('selected', isSelected);
      b.style.borderColor  = isSelected ? '#1a56db' : '#e5e7eb';
      b.style.background   = isSelected ? '#eff6ff' : 'white';
      b.style.color        = isSelected ? '#1a56db' : '#374151';
    });
  }

  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      userLanguage = lang;
      updateLangBtnUI(lang);

      const { token } = await chrome.storage.local.get('token');
      if (!token) return;

      const patchResp = await fetch(`${API_BASE}/auth/me`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ preferred_language: lang }),
      });

      if (patchResp.ok) {
        const updated = await patchResp.json();
        await chrome.storage.local.set({ user: updated });
      }

      await loadVoiceSettings();
      if (lang === 'es') await autoTranslateTagline();
      await loadTaglineSettings();
    });
  });

  // Marketplace modal close handlers
  document.getElementById('closeMarketplaceModal').onclick = () => {
    document.getElementById('marketplaceModal').style.display = 'none';
    mpModalJob = null;
  };
  document.getElementById('closeMarketplaceModal2').onclick = () => {
    document.getElementById('marketplaceModal').style.display = 'none';
    mpModalJob = null;
  };

  // Marketplace theme buttons
  document.querySelectorAll('.mp-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mpCurrentTheme = btn.dataset.theme;
      document.querySelectorAll('.mp-theme-btn').forEach(b =>
        b.classList.toggle('selected', b === btn)
      );
      generateMarketplaceDescription(mpCurrentTheme);
    });
  });

  // Marketplace submit
  document.getElementById('mpPostBtn')?.addEventListener('click', async () => {
    if (!mpModalJob) return;

    const selectedPhotos = Array.from(mpSelectedPhotos);
    if (selectedPhotos.length === 0) {
      alert('Please select at least one photo.');
      return;
    }

    const mpPostBtn    = document.getElementById('mpPostBtn');
    const description  = document.getElementById('mpDescription')?.value || '';
    const originalText = mpPostBtn.textContent;

    mpPostBtn.textContent = '⏳ Opening Marketplace...';
    mpPostBtn.disabled    = true;

    try {
      const v = mpModalJob.vehicle;

      await chrome.storage.local.set({
        fb_listing: {
          title:           [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '),
          description:     description,
          price:           v.advertised_price || v.price || '',
          vehicle:         v,
          reviewed_photos: selectedPhotos,
          video_url:       mpModalJob.result_url || null,
          created_at:      new Date().toISOString(),
        }
      });

      document.getElementById('marketplaceModal').style.display = 'none';
      mpModalJob = null;

      await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/vehicle' });

    } catch (err) {
      console.error('DealersOrbit: Marketplace post error:', err);
      alert('Failed to open Marketplace. Please try again.');
    } finally {
      mpPostBtn.textContent = originalText;
      mpPostBtn.disabled    = false;
    }
  });

  // FB Post modal close handlers
  document.getElementById("closeFbPostModal").onclick = () => {
    document.getElementById("fbPostModal").style.display = "none";
  };
  document.getElementById("closeFbPostModal2").onclick = () => {
    document.getElementById("fbPostModal").style.display = "none";
  };

  // FB Post submit handler
  document.getElementById("fbPostSubmitBtn").onclick = async () => {
    const photos = [...fbPostSelectedPhotos];
    if (photos.length === 0) {
      alert("Please select at least one photo.");
      return;
    }
    const caption = document.getElementById("fbPostCaption")?.value?.trim() || "";
    // Write caption to real clipboard while we have user gesture context —
    // the content script will execCommand('paste') into the Lexical editor,
    // which preserves line breaks (synthetic paste events do not).
    if (caption) {
      try { await navigator.clipboard.writeText(caption); } catch (e) { /* ignore */ }
    }

    const submitBtn = document.getElementById("fbPostSubmitBtn");
    const originalText = submitBtn.textContent;
    submitBtn.textContent = '⏳ Opening Facebook...';
    submitBtn.disabled = true;

    try {
      if (fbPostModalMode === 'groups') {
        await chrome.storage.local.set({
          fb_groups_post: {
            caption,
            photos,
            video_url: fbPostModalJob?.result_url || null,
            vehicle: fbPostModalJob?.vehicle,
            mode: 'groups',
            created_at: new Date().toISOString(),
          },
        });
        document.getElementById("fbPostModal").style.display = "none";
        chrome.tabs.create({ url: "https://www.facebook.com/groups/feed/?dealersorbit_groups=1" });
      } else {
        await chrome.storage.local.set({
          fb_post: {
            photos,
            caption,
            video_url: fbPostModalJob?.result_url || null,
            job_id: fbPostModalJob?.id || null,
            vehicle: fbPostModalJob?.vehicle,
            created_at: new Date().toISOString(),
          },
        });
        document.getElementById("fbPostModal").style.display = "none";
        chrome.tabs.create({ url: "https://www.facebook.com/?dealersorbit_post=1" });
      }
    } catch (err) {
      console.error('FB Post submit error:', err);
      alert('Failed to open Facebook. Please try again.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  };

  const { token, user } = await chrome.storage.local.get(["token", "user"]);

  // Clear any stuck pending_review on startup
  await chrome.storage.local.remove("pending_review");

  if (token && user) {
    // Validate token and fetch subscription state in a single call.
    // Only logs out on 401 — network errors (offline) keep the session.
    const meResp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    }).catch(() => null);

    if (meResp && meResp.status === 401 && !isLoggingIn) {
      await handleSessionExpired();
      return;
    }

    showLoggedIn(user);

    // Parse the response we already have — no second fetch needed.
    // Fall back to checkSubscriptionStatus() (cache) if the request failed.
    let subStatus = null;
    let freshUser = user;
    if (meResp && meResp.ok) {
      const meData = await meResp.json();
      freshUser = meData;
      userLanguage = meData.preferred_language || 'en';
      subStatus = {
        is_blocked:           meData.is_blocked || false,
        subscription_message: meData.subscription_message || null,
        subscription_status:  meData.subscription_status,
        cached_at:            Date.now(),
      };
      await chrome.storage.local.set({ subscription_cache: subStatus, user: meData });
    } else {
      subStatus = await checkSubscriptionStatus();
    }

    if (subStatus?.is_blocked) {
      showScreen(dashboardScreen);
      showSubscriptionOverlay(subStatus.subscription_message);
      return;
    }

    await syncSoldNotificationsFromBackend();
    await checkAndStartOnboarding(freshUser);

    renderQueue();
    await restartPollingIfNeeded();
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(renderQueue, 2000);
  } else {
    showScreen(loginScreen);
  }
}

async function restartPollingIfNeeded() {
  const { queue = [] } = await chrome.storage.local.get('queue');

  const activeJob = queue.find(j =>
    j.status === 'generating' || j.status === 'waiting'
  );

  if (!activeJob) return;

  console.log('DealersOrbit: Found in-progress job on popup open, checking status...');

  const { token } = await chrome.storage.local.get('token');
  if (!token || !activeJob.api_job_id) return;

  try {
    const resp = await fetch(`${API_BASE}/jobs/${activeJob.api_job_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) return;
    const pollData = await resp.json();

    console.log('DealersOrbit: Backend job status:', pollData.status);

    if (pollData.status === 'completed') {
      activeJob.status     = 'completed';
      activeJob.progress   = 100;
      activeJob.label      = 'Complete!';
      activeJob.result_url = pollData.final_video_url;

      const updatedQueue = queue.map(j => j.id === activeJob.id ? activeJob : j);
      await chrome.storage.local.set({ queue: updatedQueue });

      // Save to listing history (best-effort — background.js may have already done this)
      try {
        const v = activeJob.vehicle;
        await fetch(`${API_BASE}/listings/`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            job_id:      activeJob.api_job_id,
            vin:         v.vin,
            year:        v.year,
            make:        v.make,
            model:       v.model,
            trim:        v.trim,
            price:       v.price,
            mileage:     v.mileage,
            listing_url: v.listing_url,
            video_url:   pollData.final_video_url,
            photo_urls:  JSON.stringify(v.photos_for_video || []),
          }),
        });
      } catch (e) {
        // ignore — listing may already exist
      }

      console.log('DealersOrbit: Job completed while extension was closed — updated');
      renderQueue();

    } else if (pollData.status === 'failed') {
      activeJob.status = 'failed';
      activeJob.error  = pollData.error_message || 'Pipeline failed';

      const updatedQueue = queue.map(j => j.id === activeJob.id ? activeJob : j);
      await chrome.storage.local.set({ queue: updatedQueue });
      renderQueue();

    } else {
      // Still processing — tell background.js to restart polling
      console.log('DealersOrbit: Job still processing — restarting background poll');
      chrome.runtime.sendMessage({ type: 'RESTART_POLLING', job_id: activeJob.id });
    }
  } catch (err) {
    console.error('DealersOrbit: Status check failed:', err);
  }
}

function showFbListingScreen(listing, vehicle) {
  currentFbListing = { listing, vehicle };

  // Show a brief loading banner, then populate and clear it
  const loadingBanner = document.getElementById("fbLoadingBanner");
  if (loadingBanner) {
    loadingBanner.style.display = "block";
    loadingBanner.textContent = "⏳ Preparing your listing...";
  }

  showScreen(fbListingScreen);

  // Populate content on next tick so the loading state is visible briefly
  setTimeout(() => {
    const title = [vehicle.year, vehicle.make?.toUpperCase(), vehicle.model, vehicle.trim]
      .filter(Boolean).join(" ");
    fbListingTitle.textContent = title || "Vehicle Listing";
    fbListingMeta.textContent = [
      vehicle.vin ? `VIN: ${vehicle.vin}` : null,
      vehicle.price,
      vehicle.mileage,
    ].filter(Boolean).join(" · ");

    fbTitleText.textContent = listing.title;
    fbPriceText.textContent = listing.price?.replace(/[^0-9]/g, "") || "";
    fbDescText.textContent = listing.description;

    fbTagsWrap.innerHTML = (listing.tags || [])
      .map(tag => `<span class="fb-tag">#${tag}</span>`)
      .join("");

    if (loadingBanner) {
      loadingBanner.textContent = "✓ Listing ready!";
      setTimeout(() => { loadingBanner.style.display = "none"; }, 1200);
    }

    renderFbQueueStatus();
  }, 80);
}


// ── Screen management ─────────────────────────────────────────
function showScreen(screen) {
  [loginScreen, dashboardScreen, reviewScreen, fbListingScreen, settingsScreen]
    .forEach(s => { if (s) s.style.display = "none"; });
  if (screen) screen.style.display = "block";
}
function showLoggedIn(user) {
  userInfo.style.display = "flex";
  userName.textContent = user.full_name?.split(" ")[0] || user.email;
  logoutBtn.style.display = "none"; // hide old logout — using settings now
}


// ── Login ─────────────────────────────────────────────────────
loginBtn.addEventListener("click", async () => {
  if (isLoggingIn) return;
  isLoggingIn = true;

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  loginError.textContent = "";

  if (!email || !password) {
    loginError.textContent = "Please enter your email and password.";
    isLoggingIn = false;
    return;
  }

  loginBtn.textContent = "Signing in...";
  loginBtn.disabled = true;

  try {
    // OAuth2 password flow — same as Swagger login
    const formData = new URLSearchParams();
    formData.append("username", email);
    formData.append("password", password);

    const resp = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || "Login failed.");
    }

    const { access_token } = await resp.json();

    // Fetch user profile
    const userResp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    const user = await userResp.json();

    // Clear all previous user's data if switching accounts
    const { user: prevUser } = await chrome.storage.local.get('user');
    if (prevUser?.email && prevUser.email !== user.email) {
      console.log('DealersOrbit: Account switch detected, clearing previous user data');
      await chrome.storage.local.remove([
        'pending_review_queue', 'queue',
        'fb_listing', 'fb_post', 'fb_groups_post', 'fb_posting_history',
        'sold_notifications', 'last_sold_check',
        'dealer_configured', 'config_status', 'subscription_cache',
        'current_generating_vin', 'userLanguage',
      ]);
    }
    await chrome.storage.local.set({ token: access_token, user });

    showLoggedIn(user);
    renderQueue();
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(renderQueue, 2000);
    await checkAndStartOnboarding(user);

  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    isLoggingIn = false;
    loginBtn.textContent = "Sign In";
    loginBtn.disabled = false;
  }
});

// Allow Enter key to submit
document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});


// ── Logout ────────────────────────────────────────────────────
logoutBtn.addEventListener("click", async () => {
  if (queueInterval) { clearInterval(queueInterval); queueInterval = null; }
  await chrome.storage.local.remove([
    'token', 'user', 'subscription_cache',
    'pending_review_queue', 'queue',
    'fb_listing', 'fb_post', 'fb_groups_post', 'fb_posting_history',
    'sold_notifications', 'last_sold_check',
    'dealer_configured', 'config_status',
    'onboarding_card_selector', 'onboarding_detail_url',
    'onboarding_prices', 'onboarding_waiting_detail',
    'current_generating_vin', 'userLanguage', 'dealersorbit_migrated',
  ]);
  userInfo.style.display = "none";
  showScreen(loginScreen);
});


// ── Clear completed jobs ──────────────────────────────────────
clearDoneBtn.addEventListener("click", async () => {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const filtered = queue.filter(j => j.status !== "completed" && j.status !== "failed");
  await chrome.storage.local.set({ queue: filtered });
  renderQueue();
});

async function updateDashboardStats(queue) {
  // If backend listings have already populated the stats, don't overwrite with stale queue data.
  // The local queue doesn't track fb_posted, so letting it run would always show 0 for that counter.
  if (statsFromBackend) return;

  const today = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const completed = queue.filter(j => j.status === "completed");

  if (statAdsToday) statAdsToday.textContent =
    completed.filter(j => new Date(j.added_at).toDateString() === today).length;
  if (statAdsWeek) statAdsWeek.textContent =
    completed.filter(j => new Date(j.added_at).getTime() > weekAgo).length;
  if (statAdsTotal) statAdsTotal.textContent = completed.length;

  const { fb_posting_history = [] } = await chrome.storage.local.get("fb_posting_history");
  if (statFbPosted) statFbPosted.textContent = fb_posting_history.length;
}

async function loadRecentAds() {
  const { token, queue = [] } = await chrome.storage.local.get(["token", "queue"]);
  if (!recentAds) return;

  // Try backend first
  if (token) {
    try {
      const resp = await apiFetch(`${API_BASE}/listings/`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (resp.ok) {
        const listings = await resp.json();
        if (listings.length > 0) {
          renderListings(listings);
          return;
        }
      }
    } catch (err) {
      if (err.message !== "session_expired") console.error("DealersOrbit: listings fetch failed:", err);
    }
  }

  // Fallback — show completed jobs from local queue
  statsFromBackend = false; // allow queue stats to run since backend returned nothing
  const completed = queue.filter(j => j.status === "completed");
  if (completed.length === 0) {
    recentAds.innerHTML = `
      <div class="empty-hint" style="text-align:center;padding:12px;color:#9ca3af">
        Your completed ads will appear here
      </div>`;
    return;
  }

  recentAds.innerHTML = completed.reverse().map(job => {
    const v = job.vehicle;
    const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
      .filter(Boolean).join(" ");
    return `
      <div class="recent-ad-card">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title || "Unknown Vehicle"}</div>
          <div class="recent-ad-meta">${v.price || ""} · ${v.mileage || ""}</div>
          <div style="margin-top:4px">
            <span class="fb-tag" style="font-size:10px;background:#eff6ff;color:#1e40af">
              🎬 Video
            </span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${job.result_url
        ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ Video</a>`
        : ""}
        </div>
      </div>`;
  }).join("");

}

function renderListings(listings) {
  if (!recentAds) return;
  recentAds.innerHTML = listings.map(l => {
    const title = [l.year, l.make, l.model, l.trim].filter(Boolean).join(" ");
    const date = new Date(l.created_at).toLocaleDateString();
    const hasVideo = !!l.video_url;
    const hasFb = l.fb_posted;
    let typeBadge = "";
    if (hasVideo && hasFb) {
      typeBadge = `<span class="fb-tag" style="font-size:10px;background:#dcfce7;color:#15803d">🎬 Video + 📘 FB</span>`;
    } else if (hasVideo) {
      typeBadge = `<span class="fb-tag" style="font-size:10px">🎬 Video</span>`;
    } else if (hasFb) {
      typeBadge = `<span class="fb-tag" style="font-size:10px;background:#dbeafe;color:#1d4ed8">📘 FB only</span>`;
    }
    return `
      <div class="recent-ad-card">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title || "Unknown Vehicle"}</div>
          <div class="recent-ad-meta">${date} · ${l.price || ""}</div>
          <div style="margin-top:4px">${typeBadge}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${l.is_sold ? `<span class="recent-ad-sold">🚨 Sold</span>` : ""}
          ${l.video_url
        ? `<a href="${l.video_url}" target="_blank" class="btn-small">▶ Video</a>`
        : ""}
        </div>
      </div>`;
  }).join("");

  statsFromBackend = true;
  if (statAdsTotal) statAdsTotal.textContent = listings.length;
  if (statFbPosted) statFbPosted.textContent = listings.filter(l => l.fb_posted).length;
  const today = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (statAdsToday) statAdsToday.textContent =
    listings.filter(l => new Date(l.created_at).toDateString() === today).length;
  if (statAdsWeek) statAdsWeek.textContent =
    listings.filter(l => new Date(l.created_at).getTime() > weekAgo).length;
}

let recentAdsLoadCount = 0;
let statsFromBackend   = false; // once backend listings load, stop queue from overwriting stats

// ── Queue rendering ───────────────────────────────────────────
async function renderQueue() {
  if (reviewScreen?.style.display !== "none") return;
  if (fbListingScreen?.style.display !== "none") return;
  if (settingsScreen?.style.display !== "none") return;
  if (generateModal?.style.display !== "none") return;

  // Block dashboard if subscription is expired
  const subStatus = await checkSubscriptionStatus();
  if (subStatus?.is_blocked) {
    showSubscriptionOverlay(subStatus.subscription_message);
    return;
  }

  // Pick up session_expired flag set by background.js
  const { session_expired } = await chrome.storage.local.get("session_expired");
  if (session_expired) {
    await chrome.storage.local.remove("session_expired");
    await handleSessionExpired();
    return;
  }

  const { queue = [], pending_review_queue = [] } =
    await chrome.storage.local.get(["queue", "pending_review_queue"]);

  showScreen(dashboardScreen);

  // ── Review banner ─────────────────────────────────────────
  const { config_status: _cs } = await chrome.storage.local.get('config_status');
  if (_cs === 'pending_review') showReviewBanner();

  // ── Stale banner ──────────────────────────────────────────
  const { stale_review_notice } = await chrome.storage.local.get("stale_review_notice");
  const staleBanner = document.getElementById("staleBanner");
  if (stale_review_notice && staleBanner) {
    staleBanner.style.display = "flex";
    staleBanner.innerHTML = `
      <span>ℹ️ ${stale_review_notice}</span>
      <button class="btn-small" id="dismissStaleBtn">OK</button>`;
    document.getElementById("dismissStaleBtn")?.addEventListener("click", async () => {
      await chrome.storage.local.remove("stale_review_notice");
      staleBanner.style.display = "none";
    });
  } else if (staleBanner) {
    staleBanner.style.display = "none";
  }

  // ── Sold banner ───────────────────────────────────────────
  const { sold_notifications = [] } = await chrome.storage.local.get("sold_notifications");
  const soldBanner = document.getElementById("soldBanner");
  if (sold_notifications.length > 0 && soldBanner) {
    soldBanner.style.display = "flex";
    soldBanner.innerHTML = `
      <span>🚨 ${sold_notifications.length} vehicle${sold_notifications.length > 1 ? 's' : ''} may be sold</span>
      <button class="btn-small" id="dismissSoldBtn">Dismiss</button>`;
    document.getElementById("dismissSoldBtn")?.addEventListener("click", async () => {
      await chrome.storage.local.remove("sold_notifications");
      chrome.action.setBadgeText({ text: "" });
      soldBanner.style.display = "none";
    });
  } else if (soldBanner) {
    soldBanner.style.display = "none";
  }

  // ── Build unified card list ───────────────────────────────
  const allCards = [
    ...[...pending_review_queue].reverse().map(item => ({
      type: "review",
      item: item,
      vehicle: item.vehicle,
      status: item.classified ? "ready" : "classifying",
    })),
    ...[...queue].reverse().map(job => ({
      type: "job",
      item: job,
      vehicle: job.vehicle,
      status: job.status,
    })),
  ];

  if (allCards.length === 0) {
    if (queueEmpty) queueEmpty.style.display = "block";
    jobList.innerHTML = "";
  } else {
    if (queueEmpty) queueEmpty.style.display = "none";
    jobList.innerHTML = allCards.map(card => renderUnifiedCard(card)).join("");
    attachCardHandlers();
  }

  // ── Stats ─────────────────────────────────────────────────
  updateDashboardStats(queue);
  recentAdsLoadCount++;
  if (recentAdsLoadCount === 1 || recentAdsLoadCount % 10 === 0) {
    loadRecentAds();
  }
}

function renderUnifiedCard(card) {
  const v = card.vehicle;
  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  const meta = [v.mileage, v.vin ? `VIN: ${v.vin}` : null]
    .filter(Boolean).join(" · ");

  let badgeClass = "badge-waiting";
  let badgeText = "Waiting";
  let cardClass = "job-card";
  let actionBtn = "";
  let progressBar = "";

  if (card.type === "review") {
    if (card.status === "classifying") {
      badgeClass = "badge-classifying";
      badgeText = "🔍 Classifying";
      cardClass = "job-card job-card-classifying";
      actionBtn = `<button class="btn-generate classifying" disabled>
                     🔍 Classifying photos...
                   </button>`;
    } else {
      // Ready to generate
      badgeClass = "badge-waiting";
      badgeText = "Ready";
      cardClass = "job-card job-card-ready";
      actionBtn = `<button class="btn-generate generate-btn"
                            data-type="review"
                            data-vin="${v.vin || ""}"
                            data-model="${v.model || ""}"
                            data-queue-item-id="${card.item.queue_item_id || ""}">
                     Generate Ad →
                   </button>`;
    }
  } else {
    // Generation job
    const job = card.item;
    if (job.status === "waiting" || job.status === "generating") {
      badgeClass = "badge-generating";
      badgeText = job.status === "generating" ? "Generating" : "Waiting";
      cardClass = "job-card job-card-generating";
      progressBar = `<div class="progress-wrap">
                       <div class="progress-bar" style="width:${job.progress || 0}%"></div>
                     </div>
                     <div class="job-label">${job.label || ""}</div>`;
    } else if (job.status === "completed") {
      badgeClass = "badge-done";
      badgeText = "Done ✓";
      cardClass = "job-card job-card-done";
      progressBar = `<div class="progress-wrap">
                       <div class="progress-bar done" style="width:100%"></div>
                     </div>`;
      actionBtn = `<div class="job-actions">
                     ${job.result_url
          ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>`
          : ""}
                     <button class="btn-small post-marketplace-btn"
                             data-job-id="${job.id}"
                             style="background:#1877f2">
                       🏪 Marketplace
                     </button>
                     <button class='btn-small post-fb-post-btn'
                             data-job-id='${job.id}'
                             style='background:#4267B2;font-size:11px'>📘 FB Post</button>
                     <button class='btn-small post-groups-btn'
                             data-job-id='${job.id}'
                             style='background:#1b4332;font-size:11px'>👥 Groups</button>
                   </div>`;
    } else if (job.status === "failed") {
      badgeClass = "badge-failed";
      badgeText = "Failed";
      cardClass = "job-card job-card-failed";
      actionBtn = `<div class="job-label" style="color:#dc2626;font-size:11px;margin-top:4px">
                     ${getFriendlyError(job.error)}
                   </div>
                   <button class="btn-small remove-failed-btn"
                           data-job-id="${job.id}"
                           style="margin-top:6px;background:#6b7280">Remove</button>`;
    }
  }

  return `
    <div class="${cardClass}"
         data-vin="${v.vin || ""}"
         data-model="${v.model || ""}"
         data-type="${card.type}"
         data-job-id="${card.type === 'job' ? card.item.id : ''}"
         data-queue-item-id="${card.type === 'review' ? (card.item.queue_item_id || '') : ''}">
      <div class="job-top">
        <div class="job-title">${title || "Unknown Vehicle"}</div>
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="clear-card-btn" title="Remove">×</button>
      </div>
      ${meta ? `<div class="job-meta">${meta}</div>` : ""}
      ${v.price ? `<div class="job-price">${v.price}</div>` : ""}
      ${progressBar}
      ${actionBtn}
    </div>`;
}

function buildFbPostCaption(v) {
  const year = v.year || "";
  const make = v.make || "";
  const model = v.model || "";
  const trim = v.trim ? ` ${v.trim}` : "";
  const price = v.price ? `\n💰 ${v.price}` : "";
  const mileage = v.mileage ? `\n📍 ${v.mileage} miles` : "";
  const vin = v.vin ? `\nVIN: ${v.vin}` : "";
  return `🚗 ${year} ${make} ${model}${trim}${price}${mileage}${vin}\n\nContact us today to learn more!`;
}

function attachCardHandlers(allCards) {

  // Post to FB is handled by the delegated #jobList click handler using fbGeneratingJobs set.
  // No per-button listener needed here — renderUnifiedCard checks fbGeneratingJobs on each render.

  // Remove failed job
  document.querySelectorAll(".remove-failed-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const jobId = btn.dataset.jobId;
      const { queue = [] } = await chrome.storage.local.get("queue");
      await chrome.storage.local.set({
        queue: queue.filter(j => j.id !== jobId)
      });
      renderQueue();
    });
  });

  // Click card to edit photos
  document.querySelectorAll(".job-card[data-type='review']").forEach(card => {
    card.addEventListener("click", async (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;

      const vin = card.dataset.vin;
      const queueItemId = card.dataset.queueItemId;

      const { pending_review_queue = [] } =
        await chrome.storage.local.get("pending_review_queue");

      const item = pending_review_queue.find(i =>
        (queueItemId && i.queue_item_id === queueItemId) ||
        (vin && i.vehicle.vin === vin)
      );

      if (item) showReviewScreen(item);
    });
  });
}

async function showGenerateModal(vehicle) {
  modalVehicle = vehicle;
  const title = [vehicle.year, vehicle.make?.toUpperCase(), vehicle.model]
    .filter(Boolean).join(" ");
  modalVehicleTitle.textContent = title;

  // Reset to step 1 — note: modalQueueItemId is set by the caller before showGenerateModal
  modalSelectedOutroId = null;
  [modalStep1, modalStep2, modalStep3, modalStep4, modalStepOutro]
    .forEach(s => s.style.display = "none");
  modalStep1.style.display = "block";
  generateModal.style.display = "flex";

}

closeModal?.addEventListener("click", () => {
  generateModal.style.display = "none";
});

// Step 1 — choose type
document.querySelectorAll(".modal-option").forEach(btn => {
  btn.addEventListener("click", () => {
    modalSelectedType = btn.dataset.type;

    if (modalSelectedType === "photos") {
      generateModal.style.display = "none";
      generateAdWithOptions("photos", "family", null);
    } else if (modalSelectedType === "with_outro") {
      modalStep1.style.display = "none";
      modalStepOutro.style.display = "block";
      loadOutroStep();
    } else {
      // slideshow — go straight to theme selection
      modalStep1.style.display = "none";
      modalStep2.style.display = "block";
    }
  });
});

async function loadSavedScripts() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) return [];
  try {
    const resp = await apiFetch(`${API_BASE}/saved-scripts/`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    savedScripts = data.scripts || [];
    return savedScripts;
  } catch (err) {
    console.error('Could not load saved scripts:', err);
    return [];
  }
}

function renderSavedScriptsList() {
  const section  = document.getElementById('savedScriptsSection');
  const listEl   = document.getElementById('savedScriptsList');
  const inputSec = document.getElementById('promptInputSection');
  if (!section || !listEl) return;

  if (savedScripts.length === 0) {
    section.style.display  = 'none';
    return;
  }

  section.style.display  = 'block';

  listEl.innerHTML = savedScripts.map(s => `
    <div class='saved-script-option' data-script-id='${s.id}'>
      <div style='flex:1;min-width:0'>
        <div class='saved-script-name'>${s.name}</div>
        <div class='saved-script-meta'>Used ${s.use_count} times</div>
      </div>
      <button class='saved-script-delete' data-delete-id='${s.id}' title='Delete'>✕</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.saved-script-option').forEach(option => {
    option.addEventListener('click', async (e) => {
      if (e.target.closest('.saved-script-delete')) return;
      const scriptId = parseInt(option.dataset.scriptId);
      const script   = savedScripts.find(s => s.id === scriptId);
      if (!script) return;

      listEl.querySelectorAll('.saved-script-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      selectedSavedScript = script;

      section.style.display  = 'none';
      inputSec.style.display = 'block';
      const promptInput = document.getElementById('customPrompt');
      if (promptInput) { promptInput.value = script.prompt_text; promptInput.focus(); }

      const { token } = await chrome.storage.local.get('token');
      apiFetch(`${API_BASE}/saved-scripts/${scriptId}/use`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      }).catch(() => {});
    });
  });

  listEl.querySelectorAll('.saved-script-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const scriptId = parseInt(btn.dataset.deleteId);
      const { token } = await chrome.storage.local.get('token');
      try {
        await apiFetch(`${API_BASE}/saved-scripts/${scriptId}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
        });
        savedScripts = savedScripts.filter(s => s.id !== scriptId);
        renderSavedScriptsList();
      } catch (err) { console.error('Delete failed:', err); }
    });
  });
}

// Step 2 — choose theme
document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    modalSelectedTheme = btn.dataset.theme;
    document.querySelectorAll(".theme-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");

    if (modalSelectedTheme === "custom") {
      modalStep2.style.display = "none";
      selectedSavedScript    = null;
      currentGeneratedPrompt = null;
      document.getElementById('customPrompt').value = '';
      document.getElementById('promptInputSection').style.display = 'none';
      loadSavedScripts().then(renderSavedScriptsList);
      modalStep3.style.display = "block";
    } else {
      generateModal.style.display = "none";
      generateAdWithOptions(modalSelectedType, modalSelectedTheme, null);
    }
  });
});

// Back buttons
document.getElementById("backToStep1")?.addEventListener("click", () => {
  modalStep2.style.display = "none";
  modalStep1.style.display = "block";
});

document.getElementById("backFromOutroStep")?.addEventListener("click", () => {
  modalStepOutro.style.display = "none";
  modalStep1.style.display = "block";
});

document.getElementById("outroConfirmBtn")?.addEventListener("click", () => {
  modalStepOutro.style.display = "none";
  modalStep2.style.display = "block";
});

async function loadOutroStep() {
  const list = document.getElementById("outroSelectList");
  const confirmBtn = document.getElementById("outroConfirmBtn");
  modalSelectedOutroId = null;
  confirmBtn.style.display = "none";
  list.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center;padding:12px">Loading...</p>`;

  const { token } = await chrome.storage.local.get("token");
  try {
    const resp = await apiFetch(`${API_BASE}/outros/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to load outros");
    const outros = await resp.json();

    if (outros.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:16px">
          <p style="color:#6b7280;font-size:13px;margin-bottom:10px">
            No outro videos saved yet.
          </p>
          <button class="btn-secondary" id="outroGoToSettings">Add one in Settings →</button>
        </div>`;
      document.getElementById("outroGoToSettings")?.addEventListener("click", () => {
        generateModal.style.display = "none";
        showSettingsScreen();
      });
      return;
    }

    list.innerHTML = outros.map(o => `
      <div class="outro-option" data-id="${o.id}">
        <span class="outro-option-name">${o.name}</span>
        <span class="outro-check">✓</span>
      </div>`).join("");

    list.querySelectorAll(".outro-option").forEach(el => {
      el.addEventListener("click", () => {
        list.querySelectorAll(".outro-option").forEach(e => e.classList.remove("selected"));
        el.classList.add("selected");
        modalSelectedOutroId = parseInt(el.dataset.id);
        confirmBtn.style.display = "block";
      });
    });

  } catch (err) {
    if (err.message === "session_expired") return;
    list.innerHTML = `<p style="color:#dc2626;font-size:13px;text-align:center">Failed to load. Please try again.</p>`;
  }
}

document.getElementById("backToStep2")?.addEventListener("click", () => {
  modalStep3.style.display = "none";
  modalStep2.style.display = "block";
});

document.getElementById("backToStep3")?.addEventListener("click", () => {
  modalStep4.style.display = "none";
  document.getElementById('promptInputSection').style.display = 'none';
  modalStep3.style.display = "block";
});

document.getElementById('writeNewPromptBtn')?.addEventListener('click', () => {
  selectedSavedScript = null;
  document.getElementById('customPrompt').value = '';
  document.getElementById('promptInputSection').style.display = 'block';
  document.getElementById('customPrompt').focus();
});

// Step 3 — preview custom script
document.getElementById("previewScriptBtn")?.addEventListener("click", async () => {
  const prompt = document.getElementById("customPrompt")?.value.trim();
  if (!prompt) return;

  currentGeneratedPrompt = prompt;

  const btn = document.getElementById("previewScriptBtn");
  btn.textContent = "Generating script...";
  btn.disabled = true;

  try {
    const { token } = await chrome.storage.local.get("token");
    const v = modalVehicle;
    const vehicleInfo = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");

    const resp = await apiFetch(`${API_BASE}/listings/generate-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        vehicle_info: vehicleInfo,
        custom_prompt: prompt,
        language: userLanguage,
      }),
    });

    if (!resp.ok) throw new Error("Failed");
    const data = await resp.json();

    document.getElementById("scriptPreview").value = data.script;
    document.getElementById("saveScriptNameInput").value = '';
    document.getElementById("saveScriptSuccess").style.display = 'none';
    const saveBtn = document.getElementById("saveScriptBtn");
    saveBtn.textContent = 'Save';
    saveBtn.disabled = false;

    modalStep3.style.display = "none";
    modalStep4.style.display = "block";
  } catch (err) {
    alert("Failed to generate script. Please try again.");
  } finally {
    btn.textContent = "Preview Script →";
    btn.disabled = false;
  }
});

// Step 4 — save prompt
document.getElementById('saveScriptBtn')?.addEventListener('click', async () => {
  const name   = document.getElementById('saveScriptNameInput')?.value.trim();
  const prompt = currentGeneratedPrompt;
  if (!name) { document.getElementById('saveScriptNameInput')?.focus(); return; }
  if (!prompt) return;

  const saveBtn = document.getElementById('saveScriptBtn');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled    = true;

  try {
    const { token } = await chrome.storage.local.get('token');
    const resp = await apiFetch(`${API_BASE}/saved-scripts/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name, prompt_text: prompt }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || 'Save failed');
    }
    const saved = await resp.json();
    savedScripts.push(saved);
    document.getElementById('saveScriptSuccess').style.display = 'block';
    saveBtn.textContent = '✓ Saved';
    setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }, 2000);
  } catch (err) {
    alert(err.message || 'Failed to save. Please try again.');
    saveBtn.textContent = 'Save';
    saveBtn.disabled    = false;
  }
});

// Step 4 — confirm and generate
document.getElementById("confirmGenerateBtn")?.addEventListener("click", () => {
  const script = document.getElementById("scriptPreview")?.value;
  generateModal.style.display = "none";
  generateAdWithOptions(modalSelectedType, "custom", script);
});

async function generateAdWithOptions(videoType, theme, customScript) {
  // Capture all globals immediately — they can be overwritten if the user
  // clicks another card before this async function finishes awaiting.
  const capturedVehicle = reviewVehicle;
  const capturedPhotos = reviewPhotos;
  const capturedQueueItemId = modalQueueItemId;
  const capturedOutroId = modalSelectedOutroId;

  if (!capturedVehicle) return;

  const allPhotos = [
    ...(capturedPhotos.exterior || []),
    ...(capturedPhotos.interior || []),
    ...(capturedPhotos.additional || []),
  ];

  if (allPhotos.length === 0) {
    alert("No photos selected. Please click the vehicle card to review photos first.");
    return;
  }

  const vehicle = {
    ...capturedVehicle,
    photos_for_video: allPhotos,
    photos_exterior: capturedPhotos.exterior || [],
    photos_interior: capturedPhotos.interior || [],
  };

  await chrome.runtime.sendMessage({
    type: "QUEUE_REVIEWED",
    vehicle: vehicle,
    video_type: videoType,
    theme: theme,
    custom_script: customScript || null,
    outro_video_id: videoType === "with_outro" ? capturedOutroId : null,
    photos_only: videoType === "photos",
    language: userLanguage,
  });

  // Remove this specific car from the pending review queue.
  // Use queue_item_id (exact) so same-model cars don't remove each other.
  const { pending_review_queue: rawQueue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const updatedQueue = rawQueue.filter(item =>
    capturedQueueItemId
      ? item.queue_item_id !== capturedQueueItemId
      : capturedVehicle.vin
        ? item.vehicle?.vin !== capturedVehicle.vin
        : !(item.vehicle?.model === capturedVehicle.model && item.vehicle?.year === capturedVehicle.year)
  );

  await chrome.storage.local.set({ pending_review_queue: updatedQueue });
  chrome.action.setBadgeText({ text: updatedQueue.length > 0 ? String(updatedQueue.length) : "" });

  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
}

document.getElementById("toggleRecentBtn")?.addEventListener("click", () => {
  const btn = document.getElementById("toggleRecentBtn");
  const panel = document.getElementById("recentAds");
  if (panel.style.display === "none") {
    panel.style.display = "block";
    btn.textContent = "Hide";
    loadRecentAds();
  } else {
    panel.style.display = "none";
    btn.textContent = "Show";
  }
});



function getFriendlyError(error) {
  if (!error) return "Something went wrong. Please try again.";
  if (error.includes("Shotstack") && error.includes("credits"))
    return "⚠️ Video generation limit reached. Please contact support or upgrade your plan.";
  if (error.includes("401") || error.includes("Unauthorized"))
    return "⚠️ Session expired. Please sign out and sign back in.";
  if (error.includes("NHTSA") || error.includes("VIN"))
    return "⚠️ Could not decode VIN. The video may still generate with limited info.";
  if (error.includes("ElevenLabs"))
    return "⚠️ Voice generation failed. Check your ElevenLabs voice ID in Settings.";
  if (error.includes("HeyGen"))
    return "⚠️ Avatar generation failed. Check your HeyGen avatar ID in Settings.";
  if (error.includes("timeout") || error.includes("timed out"))
    return "⚠️ Generation timed out. Please try again.";
  return "⚠️ Generation failed. Please try again or contact support.";
}

function renderJobCard(job) {
  const v = job.vehicle;
  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  const meta = [v.mileage, v.vin ? `VIN: ${v.vin}` : null]
    .filter(Boolean).join(" · ");

  let badgeClass = "badge-waiting";
  let badgeText = "Waiting";
  if (job.status === "generating") { badgeClass = "badge-generating"; badgeText = "Generating"; }
  if (job.status === "completed") { badgeClass = "badge-done"; badgeText = "Done ✓"; }
  if (job.status === "failed") { badgeClass = "badge-failed"; badgeText = "Failed"; }

  const progressBarClass = job.status === "completed" ? "done" :
    job.status === "failed" ? "failed" : "";

  const actionsHtml = job.status === "completed"
    ? `<div class="job-actions" style="display:flex;gap:6px;margin-top:6px">
       ${job.result_url
      ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>`
      : `<span class="job-label" style="color:#6b7280">Fetching video...</span>`
    }
       <button class="btn-small post-fb-from-queue" 
               data-job-id="${job.id}"
               style="background:#1877f2">
         📘 Post to FB
       </button>
     </div>`
    : job.status === "failed" && job.error
      ? `<div class="job-label" style="color:#dc2626;margin-top:4px">
       ${getFriendlyError(job.error)}
     </div>
     <button class="btn-small retry-btn" data-job-id="${job.id}"
             style="margin-top:6px;background:#6b7280">
       Remove
     </button>`
      : "";

  return `
    <div class="job-card" data-job-id="${job.id}" style="cursor:pointer">
      <div class="job-top">
        <div class="job-title job-title-link">${title || "Unknown Vehicle"}</div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      ${meta ? `<div class="job-meta">${meta}</div>` : ""}
      ${v.price ? `<div class="job-price">${v.price}</div>` : ""}
      <div class="progress-wrap">
        <div class="progress-bar ${progressBarClass}"
             style="width: ${job.progress || 0}%"></div>
      </div>
      <div class="job-label">${job.label || ""}</div>
      ${actionsHtml}
    </div>
  `;
}

// ── Review screen ─────────────────────────────────────────────

// Track user's selected photos for video

async function checkPendingReview() {
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (!pending_review) return false;

  // Check if review is stale (older than 2 hours and still unclassified)
  const age = Date.now() - new Date(pending_review.added_at).getTime();
  const isStale = age > 2 * 60 * 60 * 1000 && !pending_review.classified;

  if (isStale) {
    // Show a warning notification in the dashboard
    await chrome.storage.local.set({
      stale_review_notice: `Some vehicles from your previous session need to be re-imported. Please import them again from your inventory.`
    });
    await chrome.storage.local.remove("pending_review");
    chrome.action.setBadgeText({ text: "" });
    return false;
  }

  showReviewScreen(pending_review);
  return true;
}

function buildReviewPhotos(classified, photosAll, blockedPhotos = [], explicitOther = []) {
  const explicitOtherSet = new Set(explicitOther);
  const photos = {
    exterior: classified.exterior || [],
    interior: classified.interior || [],
    additional: classified.additional || [],
    other: classified.other || [],
  };

  // Merge all unclassified photos from photos_all into other
  const allClassifiedUrls = new Set([
    ...photos.exterior,
    ...photos.interior,
    ...photos.additional,
    ...photos.other,
  ]);
  const unclassified = (photosAll || [])
    .filter(url => !allClassifiedUrls.has(url));
  photos.other = [...photos.other, ...unclassified];

  // Deduplicate across all sections
  const seenUrls = new Set();
  ['exterior', 'interior', 'additional', 'other'].forEach(section => {
    photos[section] = (photos[section] || []).filter(url => {
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
  });

  // Auto-fill additional from other to reach 20 total
  // Only after dedup and merge so logos are already in other
  const currentTotal = photos.exterior.length +
    photos.interior.length +
    photos.additional.length;
  const needed = Math.max(0, 20 - currentTotal);

  if (needed > 0) {
    const candidates = photos.other.filter(url => {
      const filename = url.split('/').pop().toLowerCase();
      const lower = url.toLowerCase();
      // Never auto-fill photos Claude explicitly said are "other"
      if (explicitOtherSet.has(url)) return false;
      if (filename.endsWith('.png')) return false;
      const junkPatterns = ['showme', 'carfax', 'valuebadge', 'videoplayer'];
      if (junkPatterns.some(p => lower.includes(p))) return false;
      return true;
    });

    const toAdd = candidates.slice(0, needed);
    photos.additional = [...photos.additional, ...toAdd];
    const addedSet = new Set(toAdd);
    photos.other = photos.other.filter(u => !addedSet.has(u));
  }

  return photos;
}

let activeJobInterval = null;

async function pollActiveJob() {
  if (activeJobPolling) return;
  activeJobPolling = true;

  // Clear any existing interval
  if (activeJobInterval) {
    clearInterval(activeJobInterval);
    activeJobInterval = null;
  }

  activeJobInterval = setInterval(async () => {
    // Declare FIRST before any usage
    const { queue = [], current_generating_vin } =
      await chrome.storage.local.get(["queue", "current_generating_vin"]);

    const currentLatestJob = current_generating_vin
      ? queue.find(j => j.vehicle?.vin === current_generating_vin) || queue[queue.length - 1]
      : queue[queue.length - 1];

    // Now safe to use
    if (!currentLatestJob) return;

    const statusEl = document.getElementById("activeJobStatus");
    const labelEl = document.getElementById("activeJobLabel");
    const barEl = document.getElementById("activeJobBar");

    if (!statusEl) return;

    statusEl.style.display = "block";
    labelEl.textContent = currentLatestJob.label || "Processing...";
    barEl.style.width = (currentLatestJob.progress || 0) + "%";

    if (currentLatestJob.status === "completed") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;

      const completedRecently = currentLatestJob.added_at &&
        (Date.now() - new Date(currentLatestJob.added_at).getTime()) < 3600000;

      statusEl.querySelectorAll("a").forEach(el => el.remove());

      if (currentLatestJob.result_url && completedRecently) {
        labelEl.textContent = "✓ Ad ready!";
        barEl.classList.add("done");
        const viewBtn = document.createElement("a");
        viewBtn.href = currentLatestJob.result_url;
        viewBtn.target = "_blank";
        viewBtn.className = "btn-small injected-view-btn";
        viewBtn.textContent = "▶ View Ad";
        viewBtn.style.marginTop = "8px";
        viewBtn.style.display = "inline-block";
        statusEl.appendChild(viewBtn);
      } else {
        statusEl.style.display = "none";
      }
      return;
    }

    if (currentLatestJob.status === "failed") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;
      labelEl.textContent = `Failed: ${currentLatestJob.error || "Unknown error"}`;
      labelEl.style.color = "#dc2626";
      barEl.classList.add("failed");
      return;
    }

    // Still running — check if we left the review screen
    if (reviewScreen.style.display === "none") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;
    }

  }, 3000);
}


function showReviewScreen(pendingReview) {
  // Kill any running poll interval
  if (activeJobInterval) {
    clearInterval(activeJobInterval);
    activeJobInterval = null;
  }
  activeJobPolling = false;
  // Reset state completely
  reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
  reviewVehicle = null;
  activeJobPolling = false;  // reset polling flag

  // Clear Ad ready banner
  const statusEl = document.getElementById("activeJobStatus");
  if (statusEl) {
    statusEl.style.display = "none";
    statusEl.querySelectorAll("a").forEach(el => el.remove());
  }
  const labelEl = document.getElementById("activeJobLabel");
  if (labelEl) labelEl.textContent = "";
  const barEl = document.getElementById("activeJobBar");
  if (barEl) {
    barEl.style.width = "0%";
    barEl.classList.remove("done", "failed");
  }

  // ... rest of function unchanged

  // Clean up injected buttons
  document.querySelectorAll(".btn-primary[href], .injected-view-btn").forEach(el => el.remove());
  if (generateBtn?.id) generateBtn.style.display = "block";

  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
  const v = pendingReview.vehicle;
  reviewVehicle = v;

  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  reviewTitle.textContent = title || "Unknown Vehicle";
  reviewMeta.textContent = [
    v.vin ? `VIN: ${v.vin}` : null,
    v.price ? v.price : null,
    v.mileage ? v.mileage : null,
  ].filter(Boolean).join(" · ");

  if (pendingReview.classified) {
    reviewStatus.style.display = "none";

    if (pendingReview.review_photos) {
      // Restore user's saved edits
      reviewPhotos = pendingReview.review_photos;
    } else {
      // Build fresh from classification
      reviewPhotos = buildReviewPhotos(
        pendingReview.classified,
        pendingReview.photos_all || pendingReview.vehicle.photos,
        pendingReview.blocked_photos || [],
        pendingReview.explicit_other || []
      );
    }

    renderPhotoSections();
    if (generateBtn?.id) generateBtn.disabled = false;
    if (facebookBtn?.id) facebookBtn.disabled = false;
    if (generateBtn?.id) generateBtn.textContent = "Generate Ad →";
  }
  else {
    reviewStatus.textContent = "🔍 Classifying photos...";
    reviewStatus.style.display = "block";
    if (generateBtn?.id) generateBtn.disabled = true;
    if (generateBtn?.id) generateBtn.textContent = "Classifying...";
    // Poll until classification is done
    pollClassification();
  }

  showScreen(reviewScreen);

  if (pendingReview.view_only && pendingReview.review_photos) {
    // Populate reviewPhotos so facebookBtn can use it
    reviewPhotos = pendingReview.review_photos;
  }

  if (pendingReview.view_only && pendingReview.completed_job?.result_url) {
    // Don't try to manipulate generateBtn DOM — just skip
  } else {
    document.querySelectorAll(".btn-primary[href]").forEach(el => el.remove());
  }
  pollActiveJob();
  // Queue preview mode — promote to active pending on generate
  if (pendingReview.queue_preview) {
    if (generateBtn?.id) generateBtn.textContent = "Start Review →";
    if (generateBtn?.id) generateBtn.disabled = false;

    // Override generate button to promote this car
    const newGenerateBtn = generateBtn.cloneNode(true);
    generateBtn.parentNode.replaceChild(newGenerateBtn, generateBtn);
    newGenerateBtn.addEventListener("click", async () => {
      const { pending_review_queue = [], pending_review } =
        await chrome.storage.local.get(["pending_review_queue", "pending_review"]);

      // Remove selected from queue
      const newQueue = [...pending_review_queue];
      newQueue.splice(pendingReview.queue_index, 1);

      // If there's a current pending_review, put it back at front
      if (pending_review && !pending_review.view_only) {
        newQueue.unshift(pending_review);
      }

      await chrome.storage.local.set({
        pending_review: { ...pendingReview, queue_preview: false },
        pending_review_queue: newQueue,
      });

      // Re-run classification for this vehicle
      chrome.runtime.sendMessage({
        type: "CLASSIFY_PENDING",
        vehicle: pendingReview.vehicle,
      });

      // Reload the review screen as active
      showReviewScreen({ ...pendingReview, queue_preview: false });
    });
  }
}

async function pollClassification() {
  const startTime = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;

  // Store the vehicle we're currently reviewing
  const vehicleVin = reviewVehicle?.vin;
  const vehicleModel = reviewVehicle?.model;

  const interval = setInterval(async () => {
    if (Date.now() - startTime > TIMEOUT_MS) {
      clearInterval(interval);
      // ... existing timeout handling unchanged
      return;
    }

    // Check pending_review for classification result
    const { pending_review, pending_review_queue = [] } =
      await chrome.storage.local.get(["pending_review", "pending_review_queue"]);

    // Find classification result — check both pending_review and queue
    let classified = null;
    let explicitOther = [];
    let blockedPhotos = [];
    let photosAll = [];

    if (pending_review?.classified && (
      pending_review.vehicle?.vin === vehicleVin ||
      pending_review.vehicle?.model === vehicleModel
    )) {
      classified = pending_review.classified;
      explicitOther = pending_review.explicit_other || [];
      blockedPhotos = pending_review.blocked_photos || [];
      photosAll = pending_review.photos_all || reviewVehicle?.photos || [];
    } else {
      // Check queue items
      const queueItem = pending_review_queue.find(item =>
        (vehicleVin && item.vehicle?.vin === vehicleVin) ||
        item.vehicle?.model === vehicleModel
      );
      if (queueItem?.classified) {
        classified = queueItem.classified;
        explicitOther = queueItem.explicit_other || [];
        blockedPhotos = queueItem.blocked_photos || [];
        photosAll = queueItem.photos_all || reviewVehicle?.photos || [];
      }
    }

    if (classified) {
      clearInterval(interval);
      reviewStatus.style.display = "none";

      reviewPhotos = buildReviewPhotos(
        classified,
        photosAll,
        blockedPhotos,
        explicitOther,
      );

      await saveReviewPhotos();
      renderPhotoSections();
      updateFbBar();
      if (generateBtn?.id) generateBtn.disabled = false;
      if (generateBtn?.id) generateBtn.textContent = "Generate Ad →";
      if (facebookBtn?.id) facebookBtn.disabled = false;
    }
  }, 2000);
}

function startFbCountdown() {
  const banner = document.getElementById("fbCountdownBanner");
  const timerEl = document.getElementById("fbCountdownTimer");
  if (!banner || !timerEl) return;

  async function updateCountdown() {
    const { fb_posting_history = [], fb_post_queue = [] } =
      await chrome.storage.local.get(["fb_posting_history", "fb_post_queue"]);

    // Find the most recent post time
    const lastPostTime = fb_posting_history
      .map(h => new Date(h.timestamp).getTime())
      .sort((a, b) => b - a)[0];

    // Find next queued item's post_after time
    const nextQueuedItem = fb_post_queue
      .filter(j => j.status === "waiting")
      .sort((a, b) => new Date(a.post_after) - new Date(b.post_after))[0];

    if (!lastPostTime && !nextQueuedItem) {
      banner.style.display = "none";
      return;
    }

    // Calculate next safe post time
    const minGap = 7 * 60 * 1000;  // 7 minutes
    const nextSafe = nextQueuedItem
      ? new Date(nextQueuedItem.post_after).getTime()
      : (lastPostTime + minGap);

    const now = Date.now();
    const remaining = nextSafe - now;

    if (remaining <= 0) {
      // Ready to post
      banner.style.display = "flex";
      banner.style.background = "#dcfce7";
      banner.style.borderColor = "#86efac";
      banner.style.color = "#15803d";
      timerEl.textContent = "Ready to post! ✓";
      timerEl.style.color = "#15803d";
      return;
    }

    // Show countdown
    banner.style.display = "flex";
    banner.style.background = "#eff6ff";
    banner.style.borderColor = "#bfdbfe";
    banner.style.color = "#1e40af";
    timerEl.style.color = "#1a56db";

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  // Update immediately then every second
  updateCountdown();
  setInterval(updateCountdown, 1000);
}

function updateFbBar() {
  const total = (reviewPhotos.exterior || []).length +
    (reviewPhotos.interior || []).length +
    (reviewPhotos.additional || []).length;
  // Note: "other/unclassified" intentionally excluded from FB count
  // since those are logos and junk the user needs to manually move or delete
  const pct = Math.min((total / 20) * 100, 100);
  const fill = document.getElementById("fbBarFill");
  const count = document.getElementById("fbCount");
  if (!fill || !count) return;
  fill.style.width = pct + "%";
  fill.classList.toggle("over", total > 20);
  count.textContent = `${total} / 20`;
  count.style.color = total > 20 ? "#dc2626" : "#374151";
}

async function saveReviewPhotos() {
  const { pending_review_queue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const idx = pending_review_queue.findIndex(item =>
    (reviewVehicle?.vin && item.vehicle?.vin === reviewVehicle.vin) ||
    item.vehicle?.model === reviewVehicle?.model
  );

  if (idx >= 0) {
    pending_review_queue[idx].review_photos = reviewPhotos;
    await chrome.storage.local.set({ pending_review_queue });
  }

  // Also save to pending_review for backward compatibility
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (pending_review) {
    pending_review.review_photos = reviewPhotos;
    await chrome.storage.local.set({ pending_review });
  }
}

function renderPhotoSections() {
  // Initialize additional if not exists

  if (!reviewPhotos.additional) reviewPhotos.additional = [];

  const sections = [
    { key: "exterior", label: "Exterior" },
    { key: "interior", label: "Interior" },
    { key: "additional", label: "Additional" },
    { key: "other", label: "Unclassified" },
  ];

  reviewSections.innerHTML = sections
    .filter(s => reviewPhotos[s.key] !== undefined)
    .map(s => `
    <div class="review-section">
      <div class="review-section-title">
        ${s.label} (${(reviewPhotos[s.key] || []).length})
      </div>
      <div class="photo-grid" data-section="${s.key}">
        ${(reviewPhotos[s.key] || []).map((url, i) => `
          <div class="photo-thumb" draggable="true"
               data-url="${url}" data-section="${s.key}" data-index="${i}">
            <img src="${url}" alt="" loading="lazy">
            <button class="remove-btn" 
                    data-url="${url}" 
                    data-section="${s.key}">×</button>
          </div>
        `).join("")}
        <div class="drop-zone" data-section="${s.key}">
          Drop here
        </div>
      </div>
    </div>
  `).join("");

  // Remove button handlers
  reviewSections.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const section = btn.dataset.section;
      reviewPhotos[section] = reviewPhotos[section].filter(u => u !== url);
      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });

  updateFbBar();
  initDragAndDrop();
}

function initDragAndDrop() {
  let dragSrc = null;

  // Drag start/end on thumbnails
  document.querySelectorAll(".photo-thumb").forEach(thumb => {
    thumb.addEventListener("dragstart", (e) => {
      dragSrc = thumb;
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => thumb.style.opacity = "0.4", 0);
    });

    thumb.addEventListener("dragend", () => {
      thumb.style.opacity = "1";
      dragSrc = null;
      document.querySelectorAll(".drop-zone, .photo-thumb").forEach(el => {
        el.classList.remove("drag-over", "drag-over-grid");
      });
    });

    thumb.addEventListener("dragover", (e) => {
      e.preventDefault();
      thumb.classList.add("drag-over");
    });

    thumb.addEventListener("dragleave", () => {
      thumb.classList.remove("drag-over");
    });

    thumb.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.classList.remove("drag-over");
      if (!dragSrc || dragSrc === thumb) return;

      const srcUrl = dragSrc.dataset.url;
      const srcSection = dragSrc.dataset.section;
      const dstSection = thumb.dataset.section;
      const dstUrl = thumb.dataset.url;

      reviewPhotos[srcSection] = reviewPhotos[srcSection].filter(u => u !== srcUrl);
      const dstIndex = reviewPhotos[dstSection].indexOf(dstUrl);
      if (dstIndex >= 0) {
        reviewPhotos[dstSection].splice(dstIndex, 0, srcUrl);
      } else {
        reviewPhotos[dstSection].push(srcUrl);
      }

      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });

  // Drop zones — one per section, always visible at bottom of grid
  document.querySelectorAll(".drop-zone").forEach(zone => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over-grid");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over-grid");
    });

    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("drag-over-grid");
      if (!dragSrc) return;

      const srcUrl = dragSrc.dataset.url;
      const srcSection = dragSrc.dataset.section;
      const dstSection = zone.dataset.section;

      if (srcSection === dstSection) return;

      reviewPhotos[srcSection] = reviewPhotos[srcSection].filter(u => u !== srcUrl);
      reviewPhotos[dstSection].push(srcUrl);

      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });
}

generateBtn.addEventListener("click", async () => {
  generateBtn.disabled = true;
  generateBtn.textContent = "Adding to queue...";
  generateBtn.style.background = "#6b7280";

  const allPhotos = [
    ...reviewPhotos.exterior,
    ...reviewPhotos.interior,
    ...(reviewPhotos.additional || []),
  ];

  if (allPhotos.length === 0) {
    alert("Please keep at least one photo.");
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Ad →";
    generateBtn.style.background = "";
    return;
  }

  if (!reviewVehicle) {
    alert("No vehicle data found. Please go back and try again.");
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Ad →";
    generateBtn.style.background = "";
    return;
  }

  const videoType = document.getElementById("videoTypeSelect")?.value || "slideshow";

  const vehicle = {
    ...reviewVehicle,
    photos_for_video: allPhotos,
    photos_exterior: reviewPhotos.exterior || [],
    photos_interior: reviewPhotos.interior || [],
  };

  const theme = document.getElementById("themeSelect")?.value ||
    videoTypeSelectDash?.value || "family";

  // Send to background for video generation
  await chrome.runtime.sendMessage({
    type: "QUEUE_REVIEWED",
    vehicle: vehicle,
    video_type: videoType,
    theme: theme,
  });

  await chrome.storage.local.set({ current_generating_vin: reviewVehicle?.vin });

  // Remove this vehicle from the pending review queue
  const { pending_review_queue: rawQueue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const updatedQueue = rawQueue.filter(item => {
    if (reviewVehicle.vin && item.vehicle.vin) {
      return item.vehicle.vin !== reviewVehicle.vin;
    }
    return !(item.vehicle.model === reviewVehicle.model &&
      item.vehicle.year === reviewVehicle.year);
  });

  await chrome.storage.local.set({ pending_review_queue: updatedQueue });

  // Update badge
  chrome.action.setBadgeText({
    text: updatedQueue.length > 0 ? String(updatedQueue.length) : ""
  });

  // Go back to dashboard
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

// ── Facebook listing button ───────────────────────────────────

facebookBtn.addEventListener("click", async () => {
  console.log("DealersOrbit: reviewPhotos state:", {
    exterior: reviewPhotos.exterior?.length,
    interior: reviewPhotos.interior?.length,
    additional: reviewPhotos.additional?.length,
  });
  facebookBtn.disabled = true;
  facebookBtn.textContent = "Generating listing...";

  try {
    const { token, pending_review } = await chrome.storage.local.get(["token", "pending_review"]);
    const v = reviewVehicle;
    if (!v) { alert("No vehicle data found."); return; }

    // Get reviewed photos from current reviewPhotos state
    // or fall back to pending_review.review_photos
    const sourcePhotos = (reviewPhotos.exterior?.length || reviewPhotos.interior?.length)
      ? reviewPhotos
      : pending_review?.review_photos;

    const reviewedPhotosList = [
      ...(sourcePhotos?.exterior || []),
      ...(sourcePhotos?.interior || []),
      ...(sourcePhotos?.additional || []),
    ];

    console.log("DealersOrbit: Reviewed photos for FB:", reviewedPhotosList.length);

    const resp = await apiFetch(`${API_BASE}/listings/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        price: v.price,
        mileage: v.mileage,
        vin: v.vin,
        dealership_name: v.dealership,
        listing_url: v.listing_url,
        language: userLanguage,
      }),
    });

    if (!resp.ok) throw new Error("Failed to generate listing");
    const listing = await resp.json();

    // Get video URL — check generation queue for this vehicle
    const { queue = [] } = await chrome.storage.local.get("queue");

    const completedJob = queue.find(j => {
      if (j.status !== "completed") return false;
      // Match by VIN first (most reliable)
      if (v.vin && j.vehicle?.vin && v.vin === j.vehicle.vin) return true;
      // Fallback: model + year + price (more specific than just model)
      return j.vehicle?.model === v.model &&
        j.vehicle?.year === v.year &&
        j.vehicle?.price === v.price;
    });

    const videoUrl = completedJob?.result_url || null;
    console.log("DealersOrbit: Found completed job:", !!completedJob, "video_url:", videoUrl);

    await chrome.storage.local.set({
      fb_listing: {
        ...listing,
        vehicle: v,
        reviewed_photos: reviewedPhotosList,
        video_url: videoUrl,
        created_at: new Date().toISOString(),
      }
    });

    showFbListingScreen(listing, v);
    // Save to sold vehicle checker immediately
    chrome.runtime.sendMessage({
      type: "MARK_LISTING_POSTED",
      vehicle: v,
      listing_url: v.listing_url,
    });

  } catch (err) {
    console.error("Facebook listing error:", err);
    alert("Failed to generate listing. Please try again.");
  } finally {
    facebookBtn.disabled = false;
    facebookBtn.textContent = "📘 Post to Facebook";
  }
});

openFbBtn.addEventListener("click", async () => {
  if (!currentFbListing) return;

  // Get current reviewed photos
  const reviewedPhotosList = [
    ...(reviewPhotos.exterior || []),
    ...(reviewPhotos.interior || []),
    ...(reviewPhotos.additional || []),
  ];

  // Update fb_listing with reviewed photos before opening Facebook
  const { fb_listing } = await chrome.storage.local.get("fb_listing");
  if (fb_listing) {
    fb_listing.reviewed_photos = reviewedPhotosList.length > 0
      ? reviewedPhotosList
      : currentFbListing.listing.reviewed_photos || [];
    await chrome.storage.local.set({ fb_listing });
  }

  await chrome.runtime.sendMessage({
    type: "ADD_TO_FB_QUEUE",
    listing: { ...currentFbListing.listing, reviewed_photos: reviewedPhotosList },
    vehicle: currentFbListing.vehicle,
  });

  renderFbQueueStatus();
});

copyAllBtn.addEventListener("click", async () => {
  if (!currentFbListing) return;
  const { listing } = currentFbListing;
  const text = `TITLE: ${listing.title}\n\nPRICE: ${listing.price}\n\nDESCRIPTION:\n${listing.description}\n\nTAGS: ${(listing.tags || []).map(t => '#' + t).join(' ')}`;
  await navigator.clipboard.writeText(text);
  copyAllBtn.textContent = "✓ Copied!";
  setTimeout(() => { copyAllBtn.textContent = "📋 Copy All to Clipboard"; }, 2000);
});

async function renderFbQueueStatus() {
  const { fb_post_queue = [] } = await chrome.storage.local.get("fb_post_queue");
  if (fb_post_queue.length === 0) {
    fbPostingStatus.style.display = "none";
    return;
  }

  fbPostingStatus.style.display = "block";
  const active = fb_post_queue.filter(j => j.status !== "posted").length;
  fbStatusLabel.textContent = `${active} in posting queue`;

  fbQueueList.innerHTML = fb_post_queue.slice(-5).map(item => {
    const v = item.vehicle;
    const title = [v.year, v.make?.toUpperCase(), v.model].filter(Boolean).join(" ");
    const statusClass = `fb-queue-status-${item.status}`;
    const statusText = {
      waiting: "⏳ Waiting",
      posting: "📘 Opening...",
      posted: "✓ Posted",
      failed: "✕ Failed",
    }[item.status] || item.status;

    return `<div class="fb-queue-item">
      <span>${title}</span>
      <span class="${statusClass}">${statusText}</span>
    </div>`;
  }).join("");
}

document.getElementById("savePhotosBtn")?.addEventListener("click", async () => {
  await saveReviewPhotos();
  // Go back to dashboard
  showScreen(dashboardScreen);
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

// Upload handler
uploadInput.addEventListener("change", (e) => {
  Array.from(e.target.files).forEach(file => {
    const url = URL.createObjectURL(file);
    reviewPhotos.exterior.push(url);
  });
  renderPhotoSections();
});


// ── Start ──────────────────────────────────────────────────────
init();
startFbCountdown();


