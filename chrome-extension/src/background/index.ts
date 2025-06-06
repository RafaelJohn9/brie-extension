import 'webextension-polyfill';
import { v4 as uuidv4 } from 'uuid';

import {
  annotationsRedoStorage,
  annotationsStorage,
  captureStateStorage,
  captureTabStorage,
  pendingReloadTabsStorage,
  userUUIDStorage,
} from '@extension/storage';
import { addOrMergeRecords, getRecords } from '@src/utils';
import { deleteRecords } from '@src/utils/manage-records.util';

chrome.tabs.onRemoved.addListener(async tabId => {
  const captureTabId = await captureTabStorage.getCaptureTabId();
  if (tabId === captureTabId) {
    await captureStateStorage.setCaptureState('idle');
    await captureTabStorage.setCaptureTabId(null);

    annotationsStorage.setAnnotations([]);
    annotationsRedoStorage.setAnnotations([]);

    deleteRecords(tabId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;

  const [state, capturedTabId] = await Promise.all([
    captureStateStorage.getCaptureState(),
    captureTabStorage.getCaptureTabId(),
  ]);

  if (!capturedTabId && state === 'unsaved') {
    await captureStateStorage.setCaptureState('idle');
  }

  if (tabId === capturedTabId) {
    await captureStateStorage.setCaptureState('idle');
    await captureTabStorage.setCaptureTabId(null);

    annotationsStorage.setAnnotations([]);
    annotationsRedoStorage.setAnnotations([]);
  }
});

/**
 * NOTE: Do Not Use async/await in onMessage listeners
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXIT_CAPTURE') {
    captureStateStorage.setCaptureState('idle');
    captureTabStorage.setCaptureTabId(null);

    annotationsStorage.setAnnotations([]);
    annotationsRedoStorage.setAnnotations([]);
    sendResponse({ status: 'success' });
  }

  if (sender?.tab?.id) {
    if (message.type === 'ADD_RECORD') {
      // Merge fetch request data from content script
      addOrMergeRecords(sender.tab.id, message.data);
      sendResponse({ status: 'success' });
    }

    if (message.type === 'GET_RECORDS') {
      getRecords(sender.tab.id).then(records => sendResponse({ records }));
    }
  } else {
    console.log('[Background] - Add Records: No sender id');
  }

  if (message.action === 'checkNativeCapture') {
    sendResponse({ isAvailable: !!chrome.tabs?.captureVisibleTab });
  }

  if (message.action === 'captureVisibleTab') {
    // Handle the async operation
    chrome.tabs.captureVisibleTab(
      null, // Current window
      { format: 'jpeg', quality: 100 },
      dataUrl => {
        if (chrome.runtime.lastError) {
          console.error('Error capturing screenshot:', chrome.runtime.lastError);
          sendResponse({ success: false, message: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, dataUrl });
        }
      },
    );
  }

  return true; // Keep the connection open for async handling
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    /**
     * Set unique identifier for the user
     * to store reported bugs when no account
     */
    const userUuid = await userUUIDStorage.get();
    if (!userUuid) await userUUIDStorage.update(uuidv4());

    // Open a welcome page
    // await chrome.tabs.create({ url: 'welcome.html' });
  }

  /**
   * @todo
   * find a better way to reload the tabs that are open when install/update happens.
   * context: see issue: #24
   */
  if (['install', 'update'].includes(reason)) {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab => {
        if (tab.id) {
          pendingReloadTabsStorage.add(tab.id);
        }
      });
    });
  }
});

/**
 * @todo
 * there is an scenario when tabId is -1,
 * but we know the requestId and we can use it to populate the right request data
 *
 * related to all 3 web req states
 */

// Listener for onCompleted
chrome.webRequest.onCompleted.addListener(
  (request: chrome.webRequest.WebResponseCacheDetails) => {
    const clonedRequest = structuredClone(request);
    addOrMergeRecords(clonedRequest.tabId, {
      recordType: 'network',
      source: 'background',
      ...clonedRequest,
    });

    if (clonedRequest.statusCode >= 400) {
      addOrMergeRecords(clonedRequest.tabId, {
        timestamp: Date.now(),
        type: 'log',
        recordType: 'console',
        source: 'background',
        method: 'error',
        args: [
          `[${clonedRequest.type}] ${clonedRequest.method} ${clonedRequest.url} responded with status ${clonedRequest.statusCode}`,
          clonedRequest,
        ],
        stackTrace: {
          parsed: 'interceptFetch',
          raw: '',
        },
        pageUrl: clonedRequest.url,
      });
    }
  },
  { urls: ['<all_urls>'] },
);

// Listener for onBeforeRequest
chrome.webRequest.onBeforeRequest.addListener(
  (request: chrome.webRequest.WebRequestBodyDetails) => {
    addOrMergeRecords(request.tabId, {
      recordType: 'network',
      source: 'background',
      ...structuredClone(request),
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody'],
);

// Listener for onBeforeSendHeaders
chrome.webRequest.onBeforeSendHeaders.addListener(
  (request: chrome.webRequest.WebRequestHeadersDetails) => {
    addOrMergeRecords(request.tabId, {
      recordType: 'network',
      source: 'background',
      ...structuredClone(request),
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders'],
);
