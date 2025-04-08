(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  const TranslationSDK = {
    config: {
      apiUrl: API_URL,
      siteId: null,
      sourceLanguage: "en", // Source = "Original"
      targetLanguage: null,
      apiKey: null,
      autoTranslate: true,
      selectors: {
        include: [
          'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'li', 'td', 'th', 'button', 'a', 'label', 'span'
        ],
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },
    _translationRetries: 0,
    _languageSelectorButton: null,
    _languageMapping: {
      en: 'Original',
      hi: 'हिन्दी (Hindi)',
      mr: 'मराठी (Marathi)',
      ta: 'தமிழ் (Tamil)',
      kn: 'ಕನ್ನಡ (Kannada)',
      pa: 'ਪੰਜਾਬੀ (Punjabi)',
      gu: 'ગુજરાતી (Gujarati)'
    },
    // LocalStorage keys
    _originalContentKey: "translationSDK_originalContent",  // mapping: hash -> original text
    _cacheKey: "translationSDK_cache",                      // mapping: hash-targetLanguage -> translated text

    /* ---------- Cache Helper Functions ---------- */
    _getCache: function() {
      console.log("[Cache] Retrieving cache from localStorage.");
      const stored = localStorage.getItem(this._cacheKey);
      try {
        const cache = stored ? JSON.parse(stored) : {};
        console.log("[Cache] Current cache:", cache);
        return cache;
      } catch (e) {
        console.error("[Cache] Error parsing cache:", e);
        return {};
      }
    },
    _setCache: function(cache) {
      console.log("[Cache] Saving cache to localStorage:", cache);
      localStorage.setItem(this._cacheKey, JSON.stringify(cache));
    },
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
    /* --------------------------------------------- */

    // --- Step 2 & 3: Scrape content, compute & set hash as element id ---
    extractContent: function() {
      console.log("[Extract] Extracting content using selectors.");
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));
      const excludeSelector = this.config.selectors.exclude.join(',');
      const excluded = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];
      const filtered = elements.filter(el => !excluded.some(ex => ex.contains(el) || el.contains(ex)));
      console.log("[Extract] Found", filtered.length, "elements after filtering.");

      // For each element, use its current text (trimmed) and assign the hash as its id.
      const extracted = filtered.map(el => {
        const originalText = el.textContent.trim();
        if (!originalText) return null;
        // IMPORTANT: Only compute & set the hash once.
        let key = el.id; // If already set, use it.
        if (!key || key.length === 0) {
          key = this._computeHash(originalText);
          el.id = key;  // Set the element id to the computed hash.
          console.log("[Extract] Assigned new id to element:", key);
        } else {
          console.log("[Extract] Using existing id for element:", key);
        }
        // You can add additional context if needed.
        return {
          id: key,
          text: originalText,
          element: el,
          type: this._getElementType(el),
          context: {}  // Can be expanded if needed.
        };
      }).filter(item => item !== null);
      console.log("[Extract] Extracted", extracted.length, "content items.");
      return extracted;
    },

    // Determine element type based on tag.
    _getElementType: function(el) {
      const tag = el.tagName.toLowerCase();
      if (['h1','h2','h3','h4','h5','h6'].includes(tag)) return 'heading';
      if (tag === 'p') return 'paragraph';
      if (tag === 'li') return 'list-item';
      if (['td','th'].includes(tag)) return 'table-cell';
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      return 'other';
    },

    // --- Step 4: Save original mapping (hash → original text) ---
    _saveOriginalContent: function() {
      console.log("[Original] Saving original content...");
      const content = this.extractContent();
      const mapping = {};
      content.forEach(item => {
        mapping[item.id] = item.text;
      });
      localStorage.setItem(this._originalContentKey, JSON.stringify(mapping));
      console.log("[Original] Original content saved:", mapping);
    },

    // --- Helper: Build array of original items using stored mapping ---
    _getOriginalContent: function() {
      console.log("[Original] Retrieving original content mapping from localStorage.");
      const stored = localStorage.getItem(this._originalContentKey);
      if (!stored) {
        console.warn("[Original] No original content mapping found.");
        return [];
      }
      const mapping = JSON.parse(stored);
      const items = [];
      for (const key in mapping) {
        const el = document.getElementById(key);
        if (el) {
          items.push({
            id: key,
            text: mapping[key],
            element: el,
            type: this._getElementType(el),
            context: {}
          });
        }
      }
      console.log("[Original] Retrieved", items.length, "original content items.");
      return items;
    },

    // --- Step 10: Restore original text when target is source ---
    _restoreOriginalContent: function() {
      console.log("[Restore] Restoring original content...");
      const mappingStr = localStorage.getItem(this._originalContentKey);
      if (!mappingStr) {
        console.warn("[Restore] No original content mapping found in localStorage.");
        return;
      }
      const mapping = JSON.parse(mappingStr);
      for (const key in mapping) {
        const el = document.getElementById(key);
        if (el) {
          el.textContent = mapping[key];
          // Remove any translation-specific CSS classes.
          Array.from(el.classList).forEach(cls => {
            if (cls.indexOf("translated-") === 0) {
              el.classList.remove(cls);
              console.log(`[Restore] Removed class ${cls} from element ${key}`);
            }
          });
          console.log(`[Restore] Restored element ${key} to original text.`);
        }
      }
      console.log("[Restore] Finished restoring original content.");
    },

    // --- Step 5: Translate page (auto or on stored target language) ---
    translatePage: function(targetLanguage) {
      console.log(`[Translate] Translating page to: ${targetLanguage}`);
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);
      console.log("[Translate] Saved target language in localStorage:", targetLanguage);

      if (this._languageSelectorButton) {
        const name = this._languageMapping[targetLanguage] || targetLanguage;
        this._languageSelectorButton.innerHTML = `<span>🌐</span> <span>${name}</span>`;
        console.log("[Translate] Updated language selector button to:", name);
      }

      // Step 10: If target equals source, restore original text.
      if (targetLanguage === this.config.sourceLanguage) {
        console.log("[Translate] Target language is the source. Restoring original content.");
        this._restoreOriginalContent();
        return;
      }

      // --- Step 6: Get original items using stable keys ---
      const originalItems = this._getOriginalContent();
      if (originalItems.length === 0 && this._translationRetries < 3) {
        this._translationRetries++;
        console.warn("[Translate] No original items found; retrying in 500ms. Retry count:", this._translationRetries);
        setTimeout(() => { this.translatePage(targetLanguage); }, 500);
        return;
      }
      this._translationRetries = 0;
      this._showLoadingIndicator();

      // --- Step 7: Try cache, else call API ---
      this._sendTranslationRequest(originalItems, (translations) => {
        console.log("[Translate] Received translations:", translations);
        this._applyTranslations(translations);
        this._hideLoadingIndicator();
      });
    },

    // --- Step 7 & 8: Send API request if cache is missing; update cache on response ---
    _sendTranslationRequest: function(contentItems, callback) {
      console.log("[API] Starting translation request for", contentItems.length, "items.");
      const cache = this._getCache();
      const toRequest = [];
      const cachedResults = [];

      contentItems.forEach(item => {
        // Use the already-set hash (item.id) to build cache key.
        const cacheKey = item.id + "-" + this.config.targetLanguage;
        if (cache[cacheKey]) {
          console.log(`[API] Cache hit for ${item.id} with key ${cacheKey}`);
          cachedResults.push({ id: item.id, translated: cache[cacheKey] });
        } else {
          console.log(`[API] Cache miss for ${item.id} with key ${cacheKey}. Queuing for API.`);
          toRequest.push(item);
        }
      });

      if (toRequest.length === 0) {
        console.log("[API] All translations found in cache.");
        callback(cachedResults);
        return;
      }

      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: toRequest.map(item => ({
          id: item.id,  // Using our stable hash.
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
        console.log("[API] Data from API:", data);
        if (data.error) {
          console.error("[API] Error from API:", data.error);
          return;
        }
        data.translations.forEach(translation => {
          const reqItem = toRequest.find(item => item.id === translation.id);
          if (reqItem) {
            const key = reqItem.id + "-" + this.config.targetLanguage;
            cache[key] = translation.translated;
            console.log(`[API] Caching translation for ${reqItem.id} with key ${key}:`, translation.translated);
          }
        });
        this._setCache(cache);
        const combined = cachedResults.concat(data.translations);
        console.log("[API] Combined translations:", combined);
        callback(combined);
      })
      .catch(error => {
        console.error("[API] Translation request failed:", error);
        this._hideLoadingIndicator();
      });
    },

    // --- Step 8: Apply translations to page elements ---
    _applyTranslations: function(translations) {
      console.log("[Apply] Applying translations to elements.");
      translations.forEach(translation => {
        const el = document.getElementById(translation.id);
        if (!el) {
          console.warn("[Apply] No element found for key:", translation.id);
          return;
        }
        el.textContent = translation.translated;
        // Remove any existing translation class.
        Array.from(el.classList).forEach(cls => {
          if (cls.indexOf("translated-") === 0) {
            el.classList.remove(cls);
            console.log(`[Apply] Removed old class ${cls} from element ${translation.id}`);
          }
        });
        el.classList.add(`translated-${this.config.targetLanguage}`);
        console.log(`[Apply] Updated element ${translation.id} with translation:`, translation.translated);
      });
      console.log("[Apply] Finished applying translations.");
    },

    // --- Simple UI Loader ---
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
    _hideLoadingIndicator: function() {
      console.log("[UI] Hiding loading indicator.");
      const indicator = document.querySelector('.translation-loading-indicator');
      if (indicator) indicator.remove();
    },

    // --- Route change listener for single-page apps ---
    _setupRouteChangeListener: function() {
      console.log("[Route] Setting up route change listener.");
      const _pushState = history.pushState;
      history.pushState = function() {
        _pushState.apply(history, arguments);
        console.log("[Route] pushState called; dispatching 'locationchange'.");
        window.dispatchEvent(new Event('locationchange'));
      };
      const _replaceState = history.replaceState;
      history.replaceState = function() {
        _replaceState.apply(history, arguments);
        console.log("[Route] replaceState called; dispatching 'locationchange'.");
        window.dispatchEvent(new Event('locationchange'));
      };
      window.addEventListener('popstate', function() {
        console.log("[Route] popstate detected; dispatching 'locationchange'.");
        window.dispatchEvent(new Event('locationchange'));
      });
      window.addEventListener('locationchange', () => {
        console.log("[Route] 'locationchange' event detected; re-triggering translation.");
        setTimeout(() => {
          TranslationSDK.translatePage(TranslationSDK.config.targetLanguage);
        }, 500);
      });
    },

    // --- Language selector UI ---
    _addLanguageSelector: function() {
      console.log("[UI] Adding language selector.");
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
        console.log("[UI] Toggled dropdown display to:", dropdown.style.display);
      });
      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
          dropdown.style.display = 'none';
          console.log("[UI] Click outside selector; hiding dropdown.");
        }
      });
      container.appendChild(button);
      container.appendChild(dropdown);
      document.body.appendChild(container);
      console.log("[UI] Language selector added.");
    }
  };

  window.TranslationSDK = TranslationSDK;
  console.log("[Global] TranslationSDK attached to window.");
})(window);
