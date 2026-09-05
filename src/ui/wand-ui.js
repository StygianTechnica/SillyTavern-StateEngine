// State Engine — extensions-menu "wand" entry point, manager button state,
// and chat-selection watching.

import { buildManagerModal, hideManagerModal } from '../../manager-modal.js';
import { getSettings } from '../core/settings-core.js';
import { setTrackerPanelVisible } from './tracker-panel-ui.js';

export function getCurrentChatId() {
    try {
        const context = window.SillyTavern?.getContext?.();
        return context?.chatId || context?.chat?.id || context?.groupId || context?.group?.id || window.chat_id || null;
    } catch (e) {
        return null;
    }
}

export function updateManagerButtonState() {
    const hasChat = !!getCurrentChatId();
    const $button = $('#se_open_manager');
    const $hint = $('#se_open_manager_hint');
    $button.prop('disabled', !hasChat);
    $hint.toggle(!hasChat);
}

export function refreshManagerButtonLater() {
    setTimeout(updateManagerButtonState, 0);
    setTimeout(updateManagerButtonState, 250);
}

export function watchChatSelection() {
    const target = document.body;
    if (!target) return;

    const observer = new MutationObserver(() => {
        updateManagerButtonState();
    });

    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-id', 'data-chat-id'] });
    updateManagerButtonState();
}

export function openManagerIfReady() {
    if (!getCurrentChatId()) {
        updateManagerButtonState();
        return;
    }
    if ($('#se-manager-overlay').length && $('#se-manager-overlay').is(':visible')) {
        hideManagerModal();
        return;
    }
    buildManagerModal();
}

function openTrackerPanelIfReady() {
    if (!getCurrentChatId()) {
        updateManagerButtonState();
        return;
    }
    const $panel = $('#se_tracker_panel');
    if ($panel.length && $panel.is(':visible')) {
        setTrackerPanelVisible(false);
        return;
    }
    setTrackerPanelVisible(true);
}

export async function addStateEngineWandUi() {
    if (!getSettings().wandVisible) return;
    const menu = $('#extensionsMenu');
    if (!menu.length || document.getElementById('state-engine-wand-button')) return;

    menu.append(`
        <div id="state-engine-wand-button" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-wand-magic-sparkles"></div>
            <span>State Engine</span>
            <i class="fa-solid fa-chevron-right se-wand-caret"></i>
        </div>
        <div id="state-engine-wand-submenu" class="se-wand-submenu" style="display:none;">
            <div id="state-engine-wand-tracker" class="list-group-item flex-container flexGap5 se-wand-subitem">
                <div class="extensionsMenuExtensionButton fa-solid fa-list"></div>
                <span>Tracker</span>
            </div>
            <div id="state-engine-wand-manager" class="list-group-item flex-container flexGap5 se-wand-subitem">
                <div class="extensionsMenuExtensionButton fa-solid fa-sliders"></div>
                <span>Manager</span>
            </div>
        </div>
    `);

    $('#state-engine-wand-button').on('click', (e) => {
        e.stopPropagation();
        $('#state-engine-wand-submenu').toggle();
        $('#state-engine-wand-button .se-wand-caret').toggleClass('fa-chevron-right fa-chevron-down');
    });

    $('#state-engine-wand-tracker').on('click', (e) => {
        e.stopPropagation();
        openTrackerPanelIfReady();
    });

    $('#state-engine-wand-manager').on('click', (e) => {
        e.stopPropagation();
        openManagerIfReady();
    });
}
