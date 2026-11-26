//! What the page viewer may load (docs/design.md, Desktop app > Page viewer). Pure: an address in, a decision out.
//!
//! - `first_page`: the page a link opens. Only `https`, only the exact hosts and page kinds of `VIEWER_SITES`, the same
//!   list as core/src/links/viewerPolicy.ts (core/test/viewer-policy.test.ts fails when they differ). Stored addresses
//!   are untrusted, so the page that asked is checked again here.
//! - `navigation`: every navigation the site's webview asks for, in any frame (WKWebView asks for subframes too): `https`
//!   on a host that is not this computer or its network, plus the two in-memory frames pages use (`about:blank`,
//!   `about:srcdoc`) and a page's own `blob:`. Everything else is dropped: `http`, `file:`, `data:`, custom schemes, and
//!   the agent on 127.0.0.1.
//! - `asks_sign_in`: a page committed in the viewer that is a sign-in, account, cart or payment page. The viewer covers it
//!   with "Sign in only in your browser": he is not signed in there, and a password belongs in his own browser.

use std::net::{Ipv4Addr, Ipv6Addr};

use tauri::Url;

pub struct Site {
  pub name: &'static str,
  pub hosts: &'static [&'static str],
  pub paths: &'static [&'static str],
  pub hash: Option<&'static str>,
}

// VIEWER_SITES begin (kept in step with core/src/links/viewerPolicy.ts)
pub const VIEWER_SITES: &[Site] = &[
  Site { name: "Home Depot", hosts: &["www.homedepot.com", "homedepot.com"], paths: &["/p/", "/s/", "/b/", "/c/", "/collection/"], hash: None },
  Site { name: "Amazon", hosts: &["www.amazon.com", "amazon.com"], paths: &["/dp/", "/gp/product/", "/*/dp/", "/s"], hash: None },
  Site { name: "Keepa", hosts: &["keepa.com", "www.keepa.com"], paths: &["/"], hash: Some("#!product/") },
  Site { name: "eBay", hosts: &["www.ebay.com", "ebay.com"], paths: &["/itm/"], hash: None },
];
// VIEWER_SITES end

fn path_matches(path: &str, prefix: &str) -> bool {
  match prefix {
    "/s" => path == "/s" || path.starts_with("/s/"),
    "/" => path == "/",
    p if p.starts_with("/*/") => {
      let rest = &p[2..];
      match path[1..].find('/') {
        Some(i) if i > 0 => path[i + 1..].starts_with(rest),
        _ => false,
      }
    }
    p => path.starts_with(p),
  }
}

/// A character no stored address needs and a parser would quietly drop or encode.
fn has_bad_char(text: &str) -> bool {
  text.chars().any(|c| c.is_control() || c == ' ' || c == '\\')
}

/// The page a link opens in the viewer, or None when the link belongs in the browser.
pub fn first_page(text: &str) -> Option<(Url, &'static Site)> {
  let text = text.trim();
  if text.is_empty() || has_bad_char(text) {
    return None;
  }
  let url = Url::parse(text).ok()?;
  if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
    return None;
  }
  let host = url.host_str()?.to_ascii_lowercase();
  let site = VIEWER_SITES.iter().find(|s| s.hosts.contains(&host.as_str()))?;
  if !site.paths.iter().any(|p| path_matches(url.path(), p)) {
    return None;
  }
  if let Some(h) = site.hash {
    let frag = url.fragment().map(|f| format!("#{f}")).unwrap_or_default();
    if !frag.starts_with(h) {
      return None;
    }
  }
  Some((url, site))
}

/// The site's name for a page on the list ("Amazon"), or None.
pub fn site_name(url: &Url) -> Option<&'static str> {
  let host = url.host_str()?.to_ascii_lowercase();
  VIEWER_SITES.iter().find(|s| s.hosts.contains(&host.as_str())).map(|s| s.name)
}

/// This computer, its network, or a name that only means this computer. The agent listens on 127.0.0.1:8790.
pub fn is_local_host(url: &Url) -> bool {
  let Some(host) = url.host_str() else { return true };
  if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
    return v6.parse::<Ipv6Addr>().map(local_v6).unwrap_or(true);
  }
  // The URL parser has already turned every IPv4 spelling (0x7f.1, 2130706433) into dotted decimal.
  if let Ok(v4) = host.parse::<Ipv4Addr>() {
    return local_v4(v4);
  }
  let d = host.trim_end_matches('.').to_ascii_lowercase();
  d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || !d.contains('.')
}

fn local_v4(ip: Ipv4Addr) -> bool {
  ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.octets()[0] == 0
}

fn local_v6(ip: Ipv6Addr) -> bool {
  if let Some(v4) = ip.to_ipv4_mapped() {
    return local_v4(v4);
  }
  let first = ip.segments()[0];
  ip.is_loopback() || ip.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Nav {
  Allow,
  Block,
}

/// Whether the site's webview may go to this address (any frame).
pub fn navigation(url: &Url) -> Nav {
  match url.scheme() {
    "https" if !is_local_host(url) && url.username().is_empty() && url.password().is_none() => Nav::Allow,
    "about" if matches!(url.path(), "blank" | "srcdoc") => Nav::Allow,
    // A page's own in-memory object: `blob:https://www.amazon.com/<uuid>`.
    "blob" => match Url::parse(url.path()) {
      Ok(inner) if inner.scheme() == "https" && !is_local_host(&inner) => Nav::Allow,
      _ => Nav::Block,
    },
    _ => Nav::Block,
  }
}

/// Whether an address the viewer may load is still one the browser should have: a link that wants a new window
/// loads in the same viewer only when it is `https` (and not local); anything else is dropped.
pub fn new_window(url: &Url) -> bool {
  url.scheme() == "https" && navigation(url) == Nav::Allow
}

const SIGN_IN_HOSTS: &[&str] = &[
  "sellercentral.amazon.com",
  "sell.amazon.com",
  "signin.ebay.com",
  "pay.ebay.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
];
const SIGN_IN_HOST_PREFIXES: &[&str] = &["signin.", "login.", "accounts.", "auth.", "pay.", "checkout.", "secure."];
/// Per site: the paths of sign-in, account, cart and checkout pages.
const SIGN_IN_PATHS: &[(&str, &[&str])] = &[
  ("amazon.com", &["/ap/", "/gp/cart", "/cart", "/gp/buy/", "/checkout/", "/gp/your-account", "/your-account", "/gp/css/", "/a/addresses", "/cpe/", "/gp/sign-in"]),
  ("homedepot.com", &["/auth/", "/myaccount", "/account/", "/mycart", "/checkout", "/order/"]),
  ("ebay.com", &["/signin", "/mye/", "/myb/", "/cart"]),
];
/// Words in a path segment that mean a sign-in page on any site.
const SIGN_IN_WORDS: &[&str] = &["signin", "sign-in", "login", "log-in", "logon"];

/// Whether a page in the viewer asks him to sign in, or is an account, cart or payment page.
pub fn asks_sign_in(url: &Url) -> bool {
  let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else { return false };
  if SIGN_IN_HOSTS.contains(&host.as_str()) || SIGN_IN_HOST_PREFIXES.iter().any(|p| host.starts_with(p)) {
    return true;
  }
  let path = url.path().to_ascii_lowercase();
  let base = host.strip_prefix("www.").unwrap_or(&host);
  if let Some((_, paths)) = SIGN_IN_PATHS.iter().find(|(h, _)| *h == base) {
    if paths.iter().any(|p| path.starts_with(p)) {
      return true;
    }
  }
  path.split('/').any(|seg| SIGN_IN_WORDS.iter().any(|w| seg == *w || seg.starts_with(&format!("{w}.")) || seg.starts_with(&format!("{w}_"))))
}

/// What identifies a page across redirects and tracking parameters: an Amazon ASIN, a Home Depot item id, an eBay
/// listing id; else the host and path. The toolbar uses it to say which of the deal's pages is on screen.
pub fn page_key(url: &Url) -> String {
  let host = url.host_str().unwrap_or("").to_ascii_lowercase();
  let base = host.strip_prefix("www.").unwrap_or(&host).to_string();
  let segs: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
  match base.as_str() {
    "amazon.com" => {
      if let Some(i) = segs.iter().position(|s| *s == "dp" || *s == "product") {
        if let Some(asin) = segs.get(i + 1) {
          return format!("amazon:{}", asin.to_ascii_uppercase());
        }
      }
      if segs.first() == Some(&"s") || url.path() == "/s" {
        let k = url.query_pairs().find(|(k, _)| k == "k").map(|(_, v)| v.to_lowercase()).unwrap_or_default();
        return format!("amazon-search:{k}");
      }
    }
    "homedepot.com" if segs.first() == Some(&"p") => {
      if let Some(id) = segs.iter().rev().find(|s| s.chars().all(|c| c.is_ascii_digit())) {
        return format!("homedepot:{id}");
      }
    }
    "ebay.com" if segs.first() == Some(&"itm") => {
      if let Some(id) = segs.iter().rev().find(|s| s.chars().all(|c| c.is_ascii_digit())) {
        return format!("ebay:{id}");
      }
    }
    "keepa.com" => {
      if let Some(f) = url.fragment() {
        return format!("keepa:{}", f.to_ascii_lowercase());
      }
    }
    _ => {}
  }
  format!("{base}{}", url.path())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  // Real addresses from fixtures/e2e-2026-11-23/after-scan6 (the same as core/test/viewer-policy.test.ts).
  const HD: &str = "https://www.homedepot.com/p/DEWALT-ATOMIC-20V-MAX-Lithium-Ion-Cordless-Combo-Kit-2-Tool-and-1-4-in-Impact-Driver-with-2-2Ah-Batteries-Charger-and-Bag-DCK225D2WCF850B/326894170";
  const AMAZON: &str = "https://www.amazon.com/dp/B0C3YBY7CD";
  const AMAZON_SLUG: &str = "https://www.amazon.com/RYOBI-Cordless-Impact-Driver-Green/dp/B0BGYFTPGK/ref=sr_1_1?keywords=RYOBI+PCL235";
  const SELLER: &str = "https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV";

  #[test]
  fn a_source_page_on_the_list_is_a_first_page() {
    for ok in [HD, "https://www.homedepot.com/p/322138483", "https://www.homedepot.com/s/DEWALT%20DCB346-3", AMAZON, AMAZON_SLUG, "https://www.amazon.com/s?k=RYOBI%20PCL702B", "https://www.ebay.com/itm/398045310682", "https://keepa.com/#!product/1-B0C3YBY7CD"] {
      assert!(first_page(ok).is_some(), "{ok}");
    }
    assert_eq!(first_page(AMAZON).unwrap().1.name, "Amazon");
  }

  #[test]
  fn anything_else_is_not() {
    for bad in [
      SELLER,
      "https://www.amazon.com/ap/signin",
      "https://www.amazon.com/",
      "https://www.homedepot.com/auth/view/signin",
      "https://serpapi.com/users/sign_up",
      "https://keepa.com/#!api",
      "https://t.me/BotFather",
      "https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.1.0/x.dmg",
      "chrome://extensions/",
      "http://www.homedepot.com/p/322138483",
      "http://127.0.0.1:8790/ui/",
      "https://127.0.0.1:8790/p/1",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "splitfinder://open",
      "https://amazon.com.evil.example/dp/B0C3YBY7CD",
      "https://smile.amazon.com/dp/B0C3YBY7CD",
      "https://www.homedepot.com@evil.example/p/322138483",
      "https://user:pass@www.amazon.com/dp/B0C3YBY7CD",
      "https://www.amazon.com:8443/dp/B0C3YBY7CD",
      "https://www.ama\tzon.com/dp/B0C3YBY7CD",
      "https://www.amazon.com\\@evil.example/dp/B0C3YBY7CD",
      "",
      "B0C3YBY7CD",
    ] {
      assert!(first_page(bad).is_none(), "{bad:?}");
    }
  }

  #[test]
  fn navigation_inside_the_viewer_is_https_away_from_this_computer() {
    for ok in [HD, AMAZON, SELLER, "https://images-na.ssl-images-amazon.com/x", "about:blank", "about:srcdoc", "blob:https://www.amazon.com/0b7f-11"] {
      assert_eq!(navigation(&u(ok)), Nav::Allow, "{ok}");
    }
    for bad in [
      "http://www.amazon.com/dp/B0C3YBY7CD",
      "http://127.0.0.1:8790/api/state",
      "https://127.0.0.1:8790/ui/",
      "https://localhost/",
      "https://agent.localhost/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://0.0.0.0/",
      "https://192.168.1.1/",
      "https://10.0.0.8/",
      "https://169.254.169.254/latest/meta-data",
      "https://router/",
      "https://printer.local/",
      "file:///Users/",
      "data:text/html,hi",
      "blob:http://127.0.0.1:8790/x",
      "javascript:alert(1)",
      "about:config",
      "splitfinder://x",
      "ftp://example.com/",
    ] {
      assert_eq!(navigation(&u(bad)), Nav::Block, "{bad}");
    }
    assert!(new_window(&u(AMAZON)));
    assert!(!new_window(&u("about:blank")));
    assert!(!new_window(&u("http://www.amazon.com/")));
  }

  #[test]
  fn sign_in_and_payment_pages_are_recognised() {
    for yes in [
      SELLER,
      "https://www.amazon.com/ap/signin?openid.return_to=x",
      "https://www.amazon.com/gp/cart/view.html",
      "https://www.amazon.com/gp/buy/spc/handlers/display.html",
      "https://www.homedepot.com/auth/view/signin",
      "https://www.homedepot.com/mycart/home",
      "https://signin.ebay.com/ws/eBayISAPI.dll",
      "https://pay.ebay.com/rxo",
      "https://accounts.google.com/o/oauth2",
      "https://example.com/account/login",
    ] {
      assert!(asks_sign_in(&u(yes)), "{yes}");
    }
    for no in [HD, AMAZON, AMAZON_SLUG, "https://www.ebay.com/itm/398045310682", "https://www.homedepot.com/s/DEWALT", "https://www.amazon.com/s?k=login+tool"] {
      assert!(!asks_sign_in(&u(no)), "{no}");
    }
  }

  #[test]
  fn a_page_is_known_across_redirects_and_tracking() {
    assert_eq!(page_key(&u(AMAZON)), "amazon:B0C3YBY7CD");
    assert_eq!(page_key(&u("https://www.amazon.com/RYOBI-x/dp/b0c3yby7cd/ref=sr_1?th=1")), "amazon:B0C3YBY7CD");
    assert_eq!(page_key(&u("https://www.homedepot.com/p/322138483")), page_key(&u("https://www.homedepot.com/p/RYOBI-ONE-Kit/322138483?MERCH=REC")));
    assert_eq!(page_key(&u("https://www.ebay.com/itm/398045310682?hash=x")), "ebay:398045310682");
    assert_eq!(page_key(&u("https://www.amazon.com/s?k=RYOBI%20PCL702B")), "amazon-search:ryobi pcl702b");
  }
}
