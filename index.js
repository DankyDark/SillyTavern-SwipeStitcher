/**
 * SwipeStitcher - SillyTavern Extension
 * Allows users to select and stitch together text fragments from multiple swipes.
 */

import { getContext } from '../../../extensions.js';
import {
    eventSource, event_types,
    saveChatConditional, reloadCurrentChat,
    extractMessageFromData,
    generateRawData,
    ensureSwipes, syncMesToSwipe,
    main_api,
} from '../../../../script.js';
import { extractReasoningFromData, parseReasoningFromString, reasoning_templates, removeReasoningFromString } from '../../../reasoning.js';

const EXTENSION_NAME = 'swipe-stitcher';
const INIT_FLAG = '__SwipeStitcherInitialized';
let isProcessing = false;
let cleanupCurrentModal = null;

const POLISH_SYSTEM_PROMPT = 'You are a precise copy editor. Rewrite only the supplied text. Output only the revised text, with no commentary.';
const THINKING_PATTERNS = [
    /^\s*<think\b[^>]*>[\s\S]*?<\/think>\s*/gi,
    /^\s*<thinking\b[^>]*>[\s\S]*?<\/thinking>\s*/gi,
    /^\s*```(?:text|markdown|md)?\s*/i,
    /\s*```\s*$/i,
];

function createElement(tag, className = '', props = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    Object.assign(element, props);
    return element;
}

function getMessage(messageId) {
    const chat = getContext().chat;
    return Array.isArray(chat) && messageId >= 0 && messageId < chat.length ? chat[messageId] : null;
}

function isStitchableMessage(message) {
    return message && !message.is_user && Array.isArray(message.swipes) && message.swipes.length > 1;
}

function addStitchIconToMessage(messageId) {
    try {
        if (messageId === null || messageId === undefined || isNaN(messageId)) return;
        if (!isStitchableMessage(getMessage(messageId))) return;

        const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (!messageElement || messageElement.querySelector('.swipe-stitcher-icon')) return;

        const buttonsContainer = messageElement.querySelector('.extraMesButtons') || messageElement.querySelector('.mes_buttons');
        if (!buttonsContainer) {
            console.debug(`[${EXTENSION_NAME}] No buttons container found for message ${messageId}`);
            return;
        }

        const stitchButton = createElement('div', 'mes_button swipe-stitcher-icon interactable', {
            innerHTML: '<i class="fa-solid fa-arrow-down-up-across-line"></i>',
            title: 'Stitch together swipes',
            tabIndex: 0,
        });
        stitchButton.dataset.mesid = messageId;

        buttonsContainer.insertBefore(stitchButton, buttonsContainer.firstChild);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error adding stitch icon to message ${messageId}:`, error);
    }
}

function addStitchIconsToMessages() {
    document.querySelectorAll('.mes[mesid]').forEach((messageElement) => {
        const messageId = Number(messageElement.getAttribute('mesid'));
        if (!Number.isNaN(messageId)) addStitchIconToMessage(messageId);
    });
}

/**
 * Build the polish/cohesion prompt for AI
 */
function buildPolishPrompt(stitchedText) {
    return `# Text Polish/Cohesion Task

You are polishing a message stitched together from multiple source versions. Your ONLY task is to rewrite the text so it flows naturally, maintains consistency in tone and style, and reads like a single coherent message.

## Critical Rules
- Output ONLY the polished message text
- Do NOT continue the story or add new events
- Do NOT add meta-commentary, explanations, or notes
- Do NOT acknowledge or reference these instructions
- Keep the same general length and narrative beats

## Text to Polish
<stitched_text>
${stitchedText}
</stitched_text>

## Your Task
Rewrite the text above into a cohesive, natural-sounding message. Preserve all key narrative beats but smooth transitions, fix any awkward phrasing, and ensure consistent tone and voice. Do not add or remove significant plot points.

Begin your polished message now:`;
}

/**
 * Clean common reasoning/model wrappers from a polish response.
 * Thinking models can emit reasoning even when quiet generation removes only the active ST template.
 */
function sanitizePolishResponse(result) {
    if (typeof result !== 'string') {
        return '';
    }

    let text = removeReasoningFromString(result).trim();

    for (const template of reasoning_templates) {
        const parsed = parseReasoningFromString(text, { strict: true }, template);
        if (parsed?.content && parsed.content !== text) {
            text = parsed.content.trim();
            break;
        }
    }

    for (const pattern of THINKING_PATTERNS) {
        text = text.replace(pattern, '');
    }
    text = text.trim();

    const taggedMatch = text.match(/<polished_message>\s*([\s\S]*?)\s*<\/polished_message>/i);
    if (taggedMatch?.[1]) {
        text = taggedMatch[1].trim();
    }

    return text;
}

async function generatePolishedText(stitchedText) {
    const data = await generateRawData({
        prompt: buildPolishPrompt(stitchedText),
        systemPrompt: POLISH_SYSTEM_PROMPT,
        instructOverride: true,
    });

    return {
        text: sanitizePolishResponse(extractMessageFromData(data, main_api)),
        reasoning: extractReasoningFromData(data, { ignoreShowThoughts: true }),
    };
}

function buildModalShell() {
    const overlay = createElement('div', 'swipe-stitcher-overlay');
    const container = createElement('div', 'swipe-stitcher-container');
    const header = createElement('div', 'swipe-stitcher-header', {
        innerHTML: `
            <h3><i class="fa-solid fa-arrow-down-up-across-line"></i> Swipe Stitcher</h3>
            <button class="swipe-stitcher-close" title="Close">&times;</button>
        `,
    });
    const body = createElement('div', 'swipe-stitcher-body');
    const footer = createElement('div', 'swipe-stitcher-footer', {
        innerHTML: `
            <button class="swipe-stitcher-cancel menu_button">Cancel</button>
            <button class="swipe-stitcher-reject-polish menu_button" hidden disabled>Reject</button>
            <button class="swipe-stitcher-add-swipe menu_button menu_button_icon">
                <i class="fa-solid fa-check"></i>
                Add as Swipe
            </button>
            <button class="swipe-stitcher-polish menu_button menu_button_icon">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                Polish
            </button>
        `,
    });

    container.append(header, body, footer);
    overlay.appendChild(container);
    return { overlay, body };
}

function buildStitcherWorkspace() {
    const mobileTabs = createElement('div', 'swipe-stitcher-mobile-tabs', {
        innerHTML: `
            <button class="swipe-stitcher-mobile-tab active" data-panel="source" type="button">Swipes</button>
            <button class="swipe-stitcher-mobile-tab" data-panel="result" type="button">Stitch</button>
        `,
    });

    const workspace = createElement('div', 'swipe-stitcher-workspace');
    const sourceArea = createElement('div', 'swipe-stitcher-source-area active');
    const tabList = createElement('div', 'swipe-stitcher-tabs');
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Message swipes');

    const previewTitle = createElement('div', 'swipe-stitcher-preview-title');
    const addBtn = createElement('button', 'swipe-stitcher-add-btn menu_button', {
        innerHTML: '<i class="fa-solid fa-plus"></i> Add Selection',
        disabled: true,
        title: 'Highlight text in the preview, then click to add it to the stitch',
    });
    const previewBody = createElement('div', 'swipe-stitcher-preview-body', { tabIndex: 0 });
    const previewHeader = createElement('div', 'swipe-stitcher-preview-header');
    const previewPanel = createElement('div', 'swipe-stitcher-preview-panel');
    previewPanel.classList.add('swipe-stitcher-preview-panel-mobile-reorderable');
    previewHeader.append(previewTitle, addBtn);
    previewPanel.append(previewHeader, previewBody);
    sourceArea.append(tabList, previewPanel);

    const resultArea = createElement('div', 'swipe-stitcher-result-area');
    const resultLabel = createElement('div', 'swipe-stitcher-result-label', {
        innerHTML: '<i class="fa-solid fa-layer-group"></i> Stitch',
    });
    const textarea = createElement('textarea', 'swipe-stitcher-result-textarea text_pole', {
        placeholder: 'Your stitched text will appear here...',
        rows: 6,
    });
    resultArea.append(resultLabel, textarea);
    workspace.append(sourceArea, resultArea);

    return { mobileTabs, workspace, sourceArea, resultArea, tabList, previewTitle, previewBody, addBtn, textarea };
}

function getStitchedText(textarea) {
    const stitchedText = textarea.value.trim();
    if (!stitchedText) {
        toastr.warning('Please stitch together some text first.');
        return null;
    }
    return stitchedText;
}

/**
 * Open the stitcher modal for a given message
 */
async function openStitcherModal(messageId) {
    if (isProcessing) {
        toastr.warning('Please wait for the current operation to complete.');
        return;
    }

    const message = getMessage(messageId);
    if (!message) {
        toastr.error('Message not found.');
        return;
    }

    // Ensure swipes are initialized
    ensureSwipes(message);
    syncMesToSwipe(messageId);

    if (!Array.isArray(message.swipes) || message.swipes.length <= 1) {
        toastr.info('This message does not have multiple swipes to stitch from.');
        return;
    }

    cleanupCurrentModal?.();
    cleanupCurrentModal = null;

    const { overlay, body } = buildModalShell();
    const workspaceParts = buildStitcherWorkspace();
    const { mobileTabs, workspace, sourceArea, resultArea, tabList, previewTitle, previewBody, addBtn, textarea } = workspaceParts;
    body.append(mobileTabs, workspace);
    document.body.appendChild(overlay);

    let activeSwipeIndex = message.swipe_id ?? 0;
    let backdropPointerDown = false;
    let modalClosed = false;
    let pendingSwipeMeta = { polished: false, reasoning: '' };
    let prePolishText = '';
    let cachedSelection = '';
    const swipeTabs = [];

    const setMobilePanel = (panel) => {
        const showSource = panel === 'source';
        sourceArea.classList.toggle('active', showSource);
        resultArea.classList.toggle('active', !showSource);
        mobileTabs.querySelectorAll('.swipe-stitcher-mobile-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.getAttribute('data-panel') === panel);
        });
    };

    const updateActiveSwipe = (index) => {
        activeSwipeIndex = index;
        const isCurrent = index === (message.swipe_id ?? 0);
        previewTitle.textContent = `Swipe #${index + 1}${isCurrent ? ' [Current]' : ''}`;
        previewBody.textContent = message.swipes[index] ?? '';
        previewBody.setAttribute('data-swipe-index', index);
        addBtn.disabled = true;
        cachedSelection = '';

        swipeTabs.forEach((tab, tabIndex) => {
            const isActive = tabIndex === index;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', String(isActive));
            tab.tabIndex = isActive ? 0 : -1;
        });
    };

    message.swipes.forEach((_swipeText, index) => {
        const isCurrent = index === (message.swipe_id ?? 0);
        const tab = createElement('button', 'swipe-stitcher-tab', {
            type: 'button',
            innerHTML: `<span>Swipe ${index + 1}</span>${isCurrent ? '<small>Current</small>' : ''}`,
        });
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', () => updateActiveSwipe(index));
        tab.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const nextIndex = (activeSwipeIndex + direction + message.swipes.length) % message.swipes.length;
            updateActiveSwipe(nextIndex);
            swipeTabs[nextIndex]?.focus();
        });
        swipeTabs.push(tab);
        tabList.appendChild(tab);
    });

    tabList.addEventListener('wheel', (event) => {
        if (tabList.scrollWidth <= tabList.clientWidth) return;

        event.preventDefault();
        tabList.scrollLeft += event.deltaY || event.deltaX;
    }, { passive: false });

    addBtn.addEventListener('click', () => {
        const selection = window.getSelection();
        const selectedText = selection?.toString()?.trim() || cachedSelection;
        if (selectedText) {
            const current = textarea.value;
            const separator = current.length > 0 && !current.endsWith('\n') ? '\n\n' : '';
            textarea.value = current + separator + selectedText;
            textarea.scrollTop = textarea.scrollHeight;
            pendingSwipeMeta = { polished: false, reasoning: '' };
            selection.removeAllRanges();
            cachedSelection = '';
            addBtn.disabled = true;
            setMobilePanel('result');
        }
    });

    mobileTabs.querySelectorAll('.swipe-stitcher-mobile-tab').forEach((tab) => {
        tab.addEventListener('click', () => setMobilePanel(tab.getAttribute('data-panel') || 'source'));
    });

    updateActiveSwipe(activeSwipeIndex);

    // Selection tracking on the overlay
    const trackSelection = () => {
        const sel = window.getSelection();
        const selString = sel?.toString()?.trim() || '';
        let inPreview = false;

        if (selString && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            inPreview = previewBody.contains(range.commonAncestorContainer);
        }

        const valid = !!(selString && inPreview);
        if (valid) {
            cachedSelection = selString;
            addBtn.disabled = false;
        } else if (!cachedSelection) {
            // Only disable if nothing is cached — keeps button alive on iOS after context menu dismissal
            addBtn.disabled = true;
        }
    };

    overlay.addEventListener('keyup', trackSelection);
    document.addEventListener('selectionchange', trackSelection);

    const focusTimer = setTimeout(() => textarea.focus(), 100);

    // Close handlers
    const closeModal = () => {
        if (modalClosed) return;

        modalClosed = true;
        clearTimeout(focusTimer);
        document.removeEventListener('selectionchange', trackSelection);
        document.removeEventListener('keydown', keyHandler);
        overlay.remove();
        if (cleanupCurrentModal === closeModal) {
            cleanupCurrentModal = null;
        }
    };
    cleanupCurrentModal = closeModal;

    overlay.querySelector('.swipe-stitcher-close').addEventListener('click', closeModal);
    overlay.querySelector('.swipe-stitcher-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('pointerdown', (event) => {
        backdropPointerDown = event.target === overlay;
    });
    overlay.addEventListener('click', (event) => {
        if (backdropPointerDown && event.target === overlay && !window.getSelection()?.toString()) {
            closeModal();
        }
        backdropPointerDown = false;
    });

    // Keyboard: Escape to close
    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    };
    document.addEventListener('keydown', keyHandler);

    textarea.addEventListener('input', () => {
        pendingSwipeMeta = { polished: false, reasoning: '' };
        const rejectButton = overlay.querySelector('.swipe-stitcher-reject-polish');
        rejectButton.hidden = true;
        rejectButton.disabled = true;
    });

    const addSwipeButton = overlay.querySelector('.swipe-stitcher-add-swipe');
    const rejectPolishButton = overlay.querySelector('.swipe-stitcher-reject-polish');
    overlay.querySelector('.swipe-stitcher-add-swipe').addEventListener('click', async () => {
        const stitchedText = getStitchedText(textarea);
        if (stitchedText) {
            closeModal();
            await addStitchedSwipe(messageId, stitchedText, pendingSwipeMeta);
        }
    });

    const polishButton = overlay.querySelector('.swipe-stitcher-polish');
    polishButton.addEventListener('click', async () => {
        const stitchedText = getStitchedText(textarea);
        if (!stitchedText || polishButton.disabled) return;

        const originalHtml = polishButton.innerHTML;
        polishButton.disabled = true;
        addSwipeButton.disabled = true;
        polishButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Polishing';
        prePolishText = stitchedText;
        rejectPolishButton.hidden = true;
        rejectPolishButton.disabled = true;

        try {
            const { text: polishedText, reasoning } = await generatePolishedText(stitchedText);
            if (modalClosed) return;

            if (!polishedText) {
                toastr.error('Failed to polish the stitched message.');
                return;
            }

            textarea.value = polishedText;
            textarea.scrollTop = 0;
            pendingSwipeMeta = { polished: true, reasoning: reasoning?.trim?.() || '' };
            setMobilePanel('result');
            rejectPolishButton.hidden = false;
            rejectPolishButton.disabled = false;
            toastr.success('Polished draft ready to review.');
        } catch (error) {
            if (modalClosed) return;

            console.error(`[${EXTENSION_NAME}] Error polishing stitched text:`, error);
            toastr.error('An error occurred while polishing the stitched text.');
        } finally {
            if (modalClosed) return;

            polishButton.disabled = false;
            addSwipeButton.disabled = false;
            polishButton.innerHTML = originalHtml;
        }
    });

    rejectPolishButton.addEventListener('click', () => {
        if (rejectPolishButton.disabled) return;

        textarea.value = prePolishText;
        pendingSwipeMeta = { polished: false, reasoning: '' };
        rejectPolishButton.hidden = true;
        rejectPolishButton.disabled = true;
        textarea.focus();
    });
}

/**
 * Save the stitched text (optionally polished) as a new swipe
 */
async function addStitchedSwipe(messageId, stitchedText, { polished = false, reasoning = '' } = {}) {
    if (isProcessing) return;

    isProcessing = true;
    const message = getMessage(messageId);

    try {
        if (!message) throw new Error(`Message ${messageId} not found`);

        // Ensure swipes structure is valid
        ensureSwipes(message);

        const newSwipeId = message.swipes.length;
        const newSwipeExtra = {
            api: EXTENSION_NAME,
            model: polished ? 'polished' : 'stitched',
            stitched: true,
            polished,
        };
        if (polished && typeof reasoning === 'string' && reasoning.trim()) {
            newSwipeExtra.reasoning = reasoning.trim();
        }

        const now = new Date().toISOString();
        message.swipes.push(stitchedText);
        message.swipe_info.push({
            send_date: now,
            gen_started: now,
            gen_finished: now,
            extra: structuredClone(newSwipeExtra),
        });

        message.swipe_id = newSwipeId;
        message.mes = stitchedText;
        message.extra = structuredClone(newSwipeExtra);
        message.swipes[newSwipeId] = stitchedText;

        await saveChatConditional();
        await reloadCurrentChat();

        toastr.success(`${polished ? 'Polished message' : 'Stitched message'} added as new swipe!`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error saving stitched swipe:`, error);
        toastr.error('An error occurred while saving the stitched swipe.');
    } finally {
        isProcessing = false;
    }
}

/**
 * Handle click on stitcher icon using event delegation
 */
function onStitcherIconClick(event) {
    const target = event.target.closest('.swipe-stitcher-icon');
    if (!target) return;

    event.stopPropagation();
    event.preventDefault();

    const messageId = parseInt(target.getAttribute('data-mesid'));
    if (!isNaN(messageId)) {
        openStitcherModal(messageId);
    }
}

/**
 * Re-evaluate and re-add icons (e.g., after swipe changes)
 */
function refreshStitchIcons() {
    document.querySelectorAll('.swipe-stitcher-icon').forEach(el => el.remove());
    addStitchIconsToMessages();
}

function schedule(callback, delay) {
    setTimeout(callback, delay);
}

// Initialize extension when jQuery is ready
jQuery(async () => {
    if (window[INIT_FLAG]) return;
    window[INIT_FLAG] = true;

    console.log(`[${EXTENSION_NAME}] Initializing...`);

    try {
        $(document).on('click', '.swipe-stitcher-icon', onStitcherIconClick);

        addStitchIconsToMessages();

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, addStitchIconToMessage);
        eventSource.on(event_types.CHAT_CHANGED, () => schedule(addStitchIconsToMessages, 100));
        eventSource.on(event_types.APP_READY, () => schedule(addStitchIconsToMessages, 100));
        eventSource.on(event_types.SETTINGS_LOADED, () => schedule(addStitchIconsToMessages, 200));
        eventSource.on(event_types.MESSAGE_SWIPED, () => schedule(refreshStitchIcons, 100));
        eventSource.on(event_types.MESSAGE_EDITED, () => schedule(refreshStitchIcons, 100));

        const chatContainer = document.getElementById('chat');
        if (chatContainer) {
            const observer = new MutationObserver((mutations) => {
                const hasNewMessages = mutations.some(mutation => [...mutation.addedNodes].some(node =>
                    node.nodeType === Node.ELEMENT_NODE && (node.classList?.contains('mes') || node.querySelector?.('.mes')),
                ));
                if (hasNewMessages) {
                    clearTimeout(observer.debounceTimer);
                    observer.debounceTimer = setTimeout(addStitchIconsToMessages, 150);
                }
            });

            observer.observe(chatContainer, { childList: true, subtree: true });
        }

        console.log(`[${EXTENSION_NAME}] Initialized successfully`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize:`, error);
    }
});
