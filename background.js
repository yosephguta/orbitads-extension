// OrbitAds Background Service Worker
// Full implementation coming in Step 21

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ADD_TO_QUEUE") {
    console.log("OrbitAds: Vehicle received:", message.vehicle);
    sendResponse({ success: true });
  }
  return true;
});