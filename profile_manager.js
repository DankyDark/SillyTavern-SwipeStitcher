import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, CONNECT_API_MAP, getGeneratingModel } from '../../../../script.js';

const EXTENSION_NAME = 'swipe-stitcher';
const PROFILE_MAX_TOKENS = 8192;

const DEFAULT_SETTINGS = {
    selectedProfileId: null,
};

let _selectorState = null;

function setPersistedProfileId(profileId) {
    extension_settings.swipeStitcher.selectedProfileId = profileId || null;
    saveSettingsDebounced();
}

export function initSettings() {
    extension_settings.swipeStitcher = extension_settings.swipeStitcher || structuredClone(DEFAULT_SETTINGS);

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings.swipeStitcher[key] === undefined) {
            extension_settings.swipeStitcher[key] = DEFAULT_SETTINGS[key];
        }
    }
}

export function isConnectionManagerAvailable() {
    try {
        const context = getContext();
        if (context.extensionSettings.disabledExtensions.includes('connection-manager')) {
            return false;
        }
        return !!context.extensionSettings.connectionManager?.profiles;
    } catch {
        return false;
    }
}

function buildProfileDropdown(select) {
    const context = getContext();
    const profiles = context.extensionSettings.connectionManager.profiles || [];
    const persistedId = extension_settings.swipeStitcher?.selectedProfileId || '';

    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default profile';
    select.appendChild(defaultOption);

    const chatCompletionProfiles = profiles
        .filter((profile) => {
            const apiMap = CONNECT_API_MAP[profile.api];
            return apiMap?.selected === 'openai';
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const profile of chatCompletionProfiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        select.appendChild(option);
    }

    const selectedProfile = profiles.find((p) => p.id === persistedId);
    const apiMap = selectedProfile ? CONNECT_API_MAP[selectedProfile.api] : null;
    if (apiMap?.selected === 'openai') {
        select.value = persistedId;
    } else {
        select.value = '';
    }

    select.addEventListener('change', () => {
        setPersistedProfileId(select.value || null);
    });
}

export function getProfileSelector() {
    if (_selectorState) {
        return _selectorState;
    }

    const select = document.createElement('select');
    select.className = 'swipe-stitcher-profile-select text_pole';
    select.title = 'Connection profile for Polish generation';

    if (!isConnectionManagerAvailable()) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'CM unavailable';
        select.disabled = true;
        select.appendChild(option);

        return { element: select, getSelected: () => null, isAvailable: false, store: () => {} };
    }

    try {
        buildProfileDropdown(select);

        _selectorState = {
            element: select,
            getSelected: () => select.value || null,
            isAvailable: true,
            store() {
                select.remove();
                _selectorState = null;
            },
        };
        return _selectorState;
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to create profile selector:`, error);
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'CM error';
        select.disabled = true;
        select.appendChild(option);

        return { element: select, getSelected: () => null, isAvailable: false, store: () => {} };
    }
}

export async function generateWithProfile(profileId, prompt, systemPrompt = '') {
    const context = getContext();

    if (!context.ConnectionManagerRequestService) {
        throw new Error('Connection Manager is not available');
    }

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await context.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        PROFILE_MAX_TOKENS,
        {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        },
        { model: getGeneratingModel() },
    );

    if (!response || typeof response.content !== 'string') {
        throw new Error('Invalid response format from profile generation');
    }

    return {
        text: response.content,
        reasoning: response.reasoning || '',
    };
}
