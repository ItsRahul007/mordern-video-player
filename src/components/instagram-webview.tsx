/**
 * A WebView pinned to instagram.com that doubles as the auth session and the
 * fetch transport for the downloader.
 *
 * Why a WebView at all: in 2026 Instagram serves a login wall to every anonymous
 * request, so extraction needs a logged-in session. The user logs in once inside
 * this WebView; its cookies (including the httpOnly `sessionid`) persist in the
 * native cookie store. To fetch a reel we inject a `fetch()` that runs in the
 * page's own context, so those cookies attach automatically — no native cookie
 * module required (which matters: the community cookie libs don't support RN's
 * New Architecture). The injected fetch posts the raw response back over the
 * message bridge; parsing happens in lib/instagram.ts.
 */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { GRAPHQL_DOC_ID, IG_APP_ID, InstagramError } from "@/lib/instagram";

export type InstagramWebViewHandle = {
  /** Run the shortcode→media GraphQL query in the page context; resolves the raw response body. */
  fetchMedia: (shortcode: string) => Promise<string>;
};

type Props = {
  /** Called whenever login state is (re)detected from the page cookies. */
  onConnectedChange: (connected: boolean) => void;
  style?: StyleProp<ViewStyle>;
};

const FETCH_TIMEOUT_MS = 25000;

/** Injected on every page load: reports whether a logged-in session cookie exists. */
const AUTH_CHECK = `
(function(){
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "auth",
      loggedIn: /ds_user_id=/.test(document.cookie)
    }));
  } catch (e) {}
  true;
})();
`;

/** Build the page-context fetch for one shortcode. Cookies ride along automatically. */
function fetchScript(id: string, shortcode: string): string {
  const body = `variables=${encodeURIComponent(
    JSON.stringify({ shortcode }),
  )}&doc_id=${GRAPHQL_DOC_ID}`;
  return `
(function(){
  try {
    var csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
    fetch("https://www.instagram.com/api/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": "${IG_APP_ID}",
        "X-CSRFToken": csrf,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: ${JSON.stringify(body)}
    })
      .then(function(r){ return r.text(); })
      .then(function(t){ window.ReactNativeWebView.postMessage(JSON.stringify({ type: "fetch", id: "${id}", ok: true, body: t })); })
      .catch(function(e){ window.ReactNativeWebView.postMessage(JSON.stringify({ type: "fetch", id: "${id}", ok: false, error: String(e) })); });
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "fetch", id: "${id}", ok: false, error: String(e) }));
  }
  true;
})();
`;
}

type Pending = {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const InstagramWebView = forwardRef<InstagramWebViewHandle, Props>(
  function InstagramWebView({ onConnectedChange, style }, ref) {
    const webRef = useRef<WebView>(null);
    const pending = useRef(new Map<string, Pending>());
    const counter = useRef(0);

    const fetchMedia = useCallback((shortcode: string) => {
      return new Promise<string>((resolve, reject) => {
        const view = webRef.current;
        if (!view) {
          reject(new InstagramError("Instagram session isn't ready yet."));
          return;
        }
        const id = `r${counter.current++}`;
        const timer = setTimeout(() => {
          pending.current.delete(id);
          reject(new InstagramError("Instagram took too long to respond."));
        }, FETCH_TIMEOUT_MS);
        pending.current.set(id, { resolve, reject, timer });
        console.log(`[instagram] inject fetch id=${id} shortcode=${shortcode}`);
        view.injectJavaScript(fetchScript(id, shortcode));
      });
    }, []);

    useImperativeHandle(ref, () => ({ fetchMedia }), [fetchMedia]);

    const onMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let msg: {
          type?: string;
          loggedIn?: boolean;
          id?: string;
          ok?: boolean;
          body?: string;
          error?: string;
        };
        try {
          msg = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }

        if (msg.type === "auth") {
          console.log(`[instagram] auth check: loggedIn=${msg.loggedIn}`);
          onConnectedChange(!!msg.loggedIn);
          return;
        }

        if (msg.type === "fetch" && msg.id) {
          const entry = pending.current.get(msg.id);
          if (!entry) return;
          pending.current.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.ok && typeof msg.body === "string") {
            console.log(
              `[instagram] fetch id=${msg.id} ok, length=${msg.body.length}`,
            );
            entry.resolve(msg.body);
          } else {
            console.warn(`[instagram] fetch id=${msg.id} failed: ${msg.error}`);
            entry.reject(
              new InstagramError("Couldn't reach Instagram. Try again."),
            );
          }
        }
      },
      [onConnectedChange],
    );

    return (
      <WebView
        ref={webRef}
        source={{ uri: "https://www.instagram.com/accounts/login/" }}
        style={style}
        // Persist the login across launches and allow cookies for the fetch.
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        injectedJavaScript={AUTH_CHECK}
        onLoadEnd={() => webRef.current?.injectJavaScript(AUTH_CHECK)}
        // Login completes via an in-app (SPA) navigation that may not fire
        // onLoadEnd, so re-check the session on every navigation change too.
        onNavigationStateChange={() =>
          webRef.current?.injectJavaScript(AUTH_CHECK)
        }
        onMessage={onMessage}
      />
    );
  },
);
