(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  // Main SDK object
  const TranslationSDK = {
    config: {
      apiUrl: API_URL,
      siteId: null,
      sourceLanguage: "en", // This is the "Original" language.
      targetLanguage: null,
      apiKey: null,
      autoTranslate: true,
      selectors: {
        // Only include textual elements; adjust as needed.
        include: [
          'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'li', 'td', 'th', 'button', 'a', 'label', 'span'
        ],
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },
    // Retry counter for content extraction.
    _translationRetries: 0,
    // Reference to the language selector button.
    _languageSelectorButton: null,
    // Mapping language codes to friendly names.
    _languageMapping: {
      en: 'Original',
      hi: 'हिन्दी (Hindi)',
      mr: 'मराठी (Marathi)',
      ta: 'தமிழ் (Tamil)',
      kn: 'ಕನ್ನಡ (Kannada)',
      pa: 'ਪੰਜਾਬੀ (Punjabi)',
      gu: 'ગુજરાતી (Gujarati)'
    },
    // LocalStorage key for storing the original (untranslated) content.
    _originalContentKey: "translationSDK_originalContent",
    // LocalStorage key for the translation cache.
    _cacheKey: "translationSDK_cache",

    /* ------------------ Helper Cache Functions ------------------ */
    _getCache: function() {
      console.log("[Cache] Retrieving cache from localStorage");
      const stored = localStorage.getItem(this._cacheKey);
      try {
        const cache = stored ? JSON.parse(stored) : {};
        console.log("[Cache] Current cache:", cache);
        return cache;
      } catch(e) {
        console.error("[Cache] Error parsing cache:", e);
        return {};
      }
    },
    _setCache: function(cache) {
      console.log("[Cache] Saving cache to localStorage:", cache);
      localStorage.setItem(this._cacheKey, JSON.stringify(cache));
    },
    // Compute a simple djb2 hash for a given string.
    _computeHash: function(str) {
      console.log("[Hash] Computing hash for string:", str);
      let hash = 5381;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
      }
      const computedHash = (hash >>> 0).toString(16);
      console.log("[Hash] Computed hash:", computedHash);
      return computedHash;
    },
    /* ------------------------------------------------------------ */

    // Save the original (untranslated) content into localStorage.
    _saveOriginalContent: function() {
      console.log("[Original] Saving original content...");
      // If already saved, do not override.
      if (localStorage.getItem(this._originalContentKey)) {
        console.log("[Original] Original content already saved. Skipping.");
        return;
      }
      const content = this.extractContent();
      const mapping = {};
      content.forEach(item => {
        mapping[item.id] = item.text;
      });
      localStorage.setItem(this._originalContentKey, JSON.stringify(mapping));
      console.log("[Original] Original content saved:", mapping);
    },

    // Restore the original content using the saved mapping.
    _restoreOriginalContent: function() {
      console.log("[Restore] Restoring original content...");
      const stored = localStorage.getItem(this._originalContentKey);
      if (!stored) {
        console.warn("[Restore] No original content found in localStorage.");
        return;
      }
      const mapping = JSON.parse(stored);
      // Loop through all elements that have a translation key.
      const elements = document.querySelectorAll("[data-translation-key]");
      elements.forEach(el => {
        const key = el.getAttribute("data-translation-key");
        if (mapping[key]) {
          console.log(`[Restore] Restoring element with key ${key}`);
          el.textContent = mapping[key];
          // Remove any class starting with "translated-"
          Array.from(el.classList).forEach(cls => {
            if (cls.indexOf("translated-") === 0) {
              el.classList.remove(cls);
              console.log(`[Restore] Removed class ${cls} from element with key ${key}`);
            }
          });
        }
      });
      console.log("[Restore] Finished restoring original content.");
    },

    // Initializes the SDK with provided options.
    init: function(options) {
      console.log("[Init] Initializing TranslationSDK with options:", options);
      this.config = { ...this.config, ...options };

      if (!this.config.siteId || !this.config.apiKey) {
        console.error("[Init] TranslationSDK: siteId and apiKey are required");
        return;
      }

      // Save the original content (after a short delay to let the page render).
      setTimeout(() => {
        this._saveOriginalContent();
      }, 50);

      // Set up the language selector UI.
      this._addLanguageSelector();
      // Set up route change detection to re-trigger translation on URL changes.
      this._setupRouteChangeListener();

      const storedLanguage = localStorage.getItem('translation_language');
      console.log("[Init] Stored language:", storedLanguage);
      // Allow a slight delay for the DOM to settle before initial translation.
      setTimeout(() => {
        if (this.config.autoTranslate) {
          console.log("[Init] Auto-translating to:", storedLanguage || this.config.targetLanguage);
          this.translatePage(storedLanguage || this.config.targetLanguage);
        } else if (storedLanguage) {
          console.log("[Init] Translating to stored language:", storedLanguage);
          this.translatePage(storedLanguage);
        }
      }, 100);

      console.log("[Init] TranslationSDK initialization complete.");
      return this;
    },

    // Extracts content elements from the document.
    extractContent: function() {
      console.log("[Extract] Extracting content using selectors.");
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));
      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];
      
      // Filter out excluded elements.
      const filteredElements = elements.filter(el =>
        !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded))
      );
      console.log("[Extract] Found", filteredElements.length, "elements after filtering.");

      const extracted = filteredElements.map(el => {
        const text = el.textContent.trim();
        if (!text.length) return null;
        // Compute hash from the element's text.
        const key = this._computeHash(text);
        // Instead of using a random ID, assign the computed hash as a data attribute.
        el.setAttribute("data-translation-key", key);
        // Optionally, you can also set el.id = key if you know texts are unique,
        // but here we rely on the data attribute for selection.
        const sectionEl = el.closest('section, article, div.section');
        const sectionTitle = sectionEl
          ? (sectionEl.querySelector('h1, h2, h3')?.textContent.trim() || "")
          : "";
        const siblings = Array.from(el.parentNode.children);
        const index = siblings.indexOf(el);
        const precedingEl = index > 0 ? siblings[index - 1] : null;
        const followingEl = index < siblings.length - 1 ? siblings[index + 1] : null;
        return {
          id: key, // Use the hash as the unique key.
          text: text,
          type: this._getElementType(el),
          element: el,
          context: {
            preceding: precedingEl ? precedingEl.textContent.trim() : '',
            following: followingEl ? followingEl.textContent.trim() : '',
            sectionTitle: sectionTitle
          }
        };
      }).filter(item => item !== null);
      console.log("[Extract] Extracted", extracted.length, "content items.");
      return extracted;
    },

    // Determines an element's type based on its tag.
    _getElementType: function(el) {
      const tag = el.tagName.toLowerCase();
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
      if (tag === 'p') return 'paragraph';
      if (tag === 'li') return 'list-item';
      if (['td', 'th'].includes(tag)) return 'table-cell';
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      return 'other';
    },

    // Triggers translation or restores original text when "Original" is selected.
    translatePage: function(targetLanguage) {
      console.log(`[Translate] Translating page to: ${targetLanguage}`);
      // Save target language and update localStorage.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);
      console.log("[Translate] Saved target language in localStorage:", targetLanguage);

      // Update the language selector button immediately.
      if (this._languageSelectorButton) {
        const languageName = this._languageMapping[targetLanguage] || targetLanguage;
        this._languageSelectorButton.innerHTML = `<span>🌐</span> <span>${languageName}</span>`;
        console.log("[Translate] Updated language selector button to:", languageName);
      }

      // If the target language is the source language, restore original content.
      if (targetLanguage === this.config.sourceLanguage) {
        console.log("[Translate] Target language is source language. Restoring original content.");
        this._restoreOriginalContent();
        return;
      }

      const content = this.extractContent();
      if (content.length === 0 && this._translationRetries < 3) {
        this._translationRetries++;
        console.warn("[Translate] No content extracted; retrying in 500ms... Retry count:", this._translationRetries);
        setTimeout(() => {
          this.translatePage(targetLanguage);
        }, 500);
        return;
      }
      this._translationRetries = 0;
      this._showLoadingIndicator();

      // Send translation request (using cache if available).
      this._sendTranslationRequest(content, (translations) => {
        console.log("[Translate] Received translations:", translations);
        this._applyTranslations(translations);
        this._hideLoadingIndicator();
      });
    },

    // Sends a translation request to the API, using localStorage as a cache.
    _sendTranslationRequest: function(content, callback) {
      console.log("[API] Starting translation request for", content.length, "items.");
      const cache = this._getCache();
      const contentToRequest = [];
      const cachedResponses = [];
      
      // Retrieve the original text mapping from localStorage.
      const storedOriginal = localStorage.getItem(this._originalContentKey);
      const originalMapping = storedOriginal ? JSON.parse(storedOriginal) : {};

      content.forEach(item => {
        const originalText = originalMapping[item.id] || item.text;
        const hash = this._computeHash(originalText);
        const cacheKey = hash + "-" + this.config.targetLanguage;
        if (cache[cacheKey]) {
          console.log(`[API] Found cached translation for item with key ${item.id} using cache key ${cacheKey}`);
          cachedResponses.push({ id: item.id, translated: cache[cacheKey] });
        } else {
          console.log(`[API] No cache found for item with key ${item.id} using cache key ${cacheKey}. Will request translation.`);
          item.hash = hash;
          contentToRequest.push(item);
        }
      });

      if (contentToRequest.length === 0) {
        console.log("[API] All translations found in cache. Returning cached responses.");
        callback(cachedResponses);
        return;
      }

      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: contentToRequest.map(item => ({
          id: item.id, // This is the hash key.
          text: item.text,
          type: item.type,
          context: item.context
        }))
      };
      console.log("[API] Sending payload to API:", payload);

      fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(payload)
      })
      .then(response => {
        console.log("[API] Received response with status:", response.status);
        if (!response.ok) {
          throw new Error("Translation API error: " + response.statusText);
        }
        return response.json();
      })
      .then(data => {
        console.log("[API] Data received from API:", data);
        if (data.error) {
          console.error("[API] Translation error from API:", data.error);
          return;
        }
        data.translations.forEach(translation => {
          const originalItem = contentToRequest.find(item => item.id === translation.id);
          if (originalItem) {
            const key = originalItem.hash + "-" + this.config.targetLanguage;
            cache[key] = translation.translated;
            console.log(`[API] Caching translation for item with key ${originalItem.id} using cache key ${key}:`, translation.translated);
          }
        });
        this._setCache(cache);
        const combined = cachedResponses.concat(data.translations);
        console.log("[API] Combined translations:", combined);
        callback(combined);
      })
      .catch(error => {
        console.error("[API] Translation request failed:", error);
        this._hideLoadingIndicator();
      });
    },

    // Applies translations to the page and adds a language-specific CSS class.
    _applyTranslations: function(translations) {
      console.log("[Apply] Applying translations to page elements.");
      translations.forEach(translation => {
        // Find the element using its data-translation-key attribute.
        const element = document.querySelector('[data-translation-key="' + translation.id + '"]');
        if (!element) {
          console.warn("[Apply] Element not found for translation key:", translation.id);
          return;
        }
        element.textContent = translation.translated;
        Array.from(element.classList).forEach(cls => {
          if (cls.indexOf("translated-") === 0) {
            element.classList.remove(cls);
            console.log(`[Apply] Removed old class ${cls} from element with key ${translation.id}`);
          }
        });
        element.classList.add(`translated-${this.config.targetLanguage}`);
        console.log(`[Apply] Applied translation for element with key ${translation.id}: ${translation.translated}`);
      });
      console.log("[Apply] Finished applying translations.");
    },

    // Sets up a listener for route changes (for single-page applications).
    _setupRouteChangeListener: function() {
      console.log("[Route] Setting up route change listener.");
      const _pushState = history.pushState;
      history.pushState = function() {
        _pushState.apply(history, arguments);
        console.log("[Route] pushState called, dispatching 'locationchange' event.");
        window.dispatchEvent(new Event('locationchange'));
      };
      const _replaceState = history.replaceState;
      history.replaceState = function() {
        _replaceState.apply(history, arguments);
        console.log("[Route] replaceState called, dispatching 'locationchange' event.");
        window.dispatchEvent(new Event('locationchange'));
      };
      window.addEventListener('popstate', function() {
        console.log("[Route] popstate event detected, dispatching 'locationchange' event.");
        window.dispatchEvent(new Event('locationchange'));
      });
      window.addEventListener('locationchange', () => {
        console.log("[Route] 'locationchange' event detected.");
        setTimeout(() => {
          console.log("[Route] Re-triggering translation on route change.");
          TranslationSDK.translatePage(TranslationSDK.config.targetLanguage);
        }, 500);
      });
    },

    // Adds the language selector dropdown UI.
    _addLanguageSelector: function() {
      console.log("[UI] Adding language selector UI.");
      const container = document.createElement('div');
      container.className = 'translation-language-selector no-translate';
      container.style.position = 'fixed';
      container.style.bottom = '20px';
      container.style.right = '20px';
      container.style.background = 'white';
      container.style.border = '1px solid #ddd';
      container.style.borderRadius = '4px';
      container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
      container.style.zIndex = '9999';
      container.style.overflow = 'hidden';

      const button = document.createElement('button');
      const initLang = this.config.targetLanguage || this.config.sourceLanguage;
      const initName = this._languageMapping[initLang] || initLang;
      button.innerHTML = `<span>🌐</span> <span>${initName}</span>`;
      button.style.background = 'none';
      button.style.border = 'none';
      button.style.padding = '10px 15px';
      button.style.cursor = 'pointer';
      button.style.display = 'flex';
      button.style.alignItems = 'center';
      button.style.gap = '8px';
      button.style.fontFamily = 'system-ui, sans-serif';
      button.style.fontSize = '14px';

      this._languageSelectorButton = button;

      const dropdown = document.createElement('div');
      dropdown.className = 'translation-language-dropdown';
      dropdown.style.display = 'none';
      dropdown.style.padding = '5px 0';
      dropdown.style.borderTop = '1px solid #ddd';

      const languages = [
        { code: this.config.sourceLanguage, name: this._languageMapping[this.config.sourceLanguage] },
        { code: 'hi', name: this._languageMapping['hi'] },
        { code: 'mr', name: this._languageMapping['mr'] },
        { code: 'ta', name: this._languageMapping['ta'] },
        { code: 'kn', name: this._languageMapping['kn'] },
        { code: 'pa', name: this._languageMapping['pa'] },
        { code: 'gu', name: this._languageMapping['gu'] }
      ];

      languages.forEach(lang => {
        const option = document.createElement('button');
        option.textContent = lang.name;
        option.dataset.language = lang.code;
        option.style.background = 'none';
        option.style.border = 'none';
        option.style.padding = '8px 15px';
        option.style.textAlign = 'left';
        option.style.cursor = 'pointer';
        option.style.width = '100%';
        option.style.fontSize = '14px';
        option.style.fontFamily = 'system-ui, sans-serif';

        option.addEventListener('click', () => {
          console.log(`[UI] Language option selected: ${lang.code}`);
          TranslationSDK.translatePage(lang.code);
          dropdown.style.display = 'none';
          Array.from(dropdown.children).forEach(child => {
            child.style.backgroundColor = 'transparent';
          });
          option.style.backgroundColor = '#f0f0f0';
        });

        dropdown.appendChild(option);
      });

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = (dropdown.style.display === 'none') ? 'block' : 'none';
        console.log("[UI] Toggled language dropdown display to:", dropdown.style.display);
      });

      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
          dropdown.style.display = 'none';
          console.log("[UI] Click outside language selector. Hiding dropdown.");
        }
      });

      container.appendChild(button);
      container.appendChild(dropdown);
      document.body.appendChild(container);
      console.log("[UI] Language selector UI added.");
    },

    // Displays a loading indicator.
    _showLoadingIndicator: function() {
      console.log("[UI] Showing loading indicator.");
      if (document.querySelector('.translation-loading-indicator')) return;
      const indicator = document.createElement('div');
      indicator.className = 'translation-loading-indicator';
      indicator.style.position = 'fixed';
      indicator.style.top = '10px';
      indicator.style.right = '10px';
      indicator.style.background = 'rgba(0,0,0,0.7)';
      indicator.style.color = 'white';
      indicator.style.padding = '8px 15px';
      indicator.style.borderRadius = '4px';
      indicator.style.fontFamily = 'system-ui, sans-serif';
      indicator.style.fontSize = '14px';
      indicator.style.zIndex = '10000';
      indicator.textContent = 'Translating...';
      document.body.appendChild(indicator);
    },

    // Removes the loading indicator.
    _hideLoadingIndicator: function() {
      console.log("[UI] Hiding loading indicator.");
      const indicator = document.querySelector('.translation-loading-indicator');
      if (indicator) {
        indicator.remove();
      }
    }
  };

  // Expose the SDK globally.
  window.TranslationSDK = TranslationSDK;
  console.log("[Global] TranslationSDK has been attached to the window object.");
})(window);
