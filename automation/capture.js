(function(){
  async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function waitForAppShell(timeout=8000){
    const t0 = Date.now();
    while(Date.now()-t0 < timeout){
      const main = document.querySelector('main,[role="main"]');
      if (main) return main;
      await sleep(120);
    }
    throw new Error("app_shell_timeout");
  }

  function getConvoIdFromUrl(href=location.href){
    const m = href.match(/\/c\/([a-f0-9-]{10,})/i);
    return m ? m[1] : null;
  }

  function deepText(el){
    if(!el) return "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let s=""; while(walker.nextNode()) s += walker.currentNode.nodeValue;
    return s.trim();
  }

  function sanitizeHTML(node){
    const clone = node.cloneNode(true);
    // strip scripts & inline handlers
    clone.querySelectorAll('script,style').forEach(n=>n.remove());
    clone.querySelectorAll('*').forEach(n=>{
      [...n.attributes].forEach(a=>{
        if(/^on/i.test(a.name)) n.removeAttribute(a.name);
      });
    });
    return clone.innerHTML;
  }

  async function extractFirstPair(timeout=8000){
    await waitForAppShell(timeout);
    const convoId = getConvoIdFromUrl();
    if(!convoId) throw new Error("not_conversation_url");

    // The main conversation pane typically has first user and first assistant blocks.
    // Use broad selectors but scope to main.
    const main = document.querySelector('main,[role="main"]');
    if(!main) throw new Error("no_main");

    // USER bubble: pick first prompt block (heuristic)
    let userEl = main.querySelector('[data-message-author="user"], [data-testid*="user-message"], article:has([data-testid*="user"])');
    // Fallback: first heading/bubble at top
    if(!userEl){
      const maybe = main.querySelector('article, [data-testid*="message"]');
      userEl = maybe || null;
    }
    const userText = userEl ? deepText(userEl).slice(0, 4000) : "";

    // ASSISTANT bubble after user
    let assistantEl = null;
    const candidates = main.querySelectorAll('[data-message-author="assistant"], [data-testid*="assistant-message"], article:has([data-testid*="assistant"])');
    if(candidates && candidates.length){
      assistantEl = candidates[0];
    }
    const assistantHTML = assistantEl ? sanitizeHTML(assistantEl) : "";

    const counts = {
      user: userText ? 1 : 0,
      assistant: assistantHTML ? 1 : 0
    };

    return {
      convoId,
      createdAt: Date.now(),
      userText,
      assistantHTML,
      counts
    };
  }

  async function captureNow(){
    const payload = await extractFirstPair();
    return { ok:true, payload };
  }

  window.__MYCHAT_CAPTURE__ = { captureNow, extractFirstPair };
})();
