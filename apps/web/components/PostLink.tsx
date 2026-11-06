// Corner link on a Social digest post: the platform's logo, with the post's address as a
// tooltip on hover or keyboard focus. Platform from the address, else from the source type.
import { LinkedinLogo, RedditLogo } from "@phosphor-icons/react/ssr";
import type { SourceType } from "@bs/core";

function platformOf(url: string, sourceType: SourceType): "LinkedIn" | "Reddit" {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") return "Reddit";
  return sourceType === "linkedin_post" ? "LinkedIn" : "Reddit";
}

export function PostLink({ url, sourceType, id }: { url: string; sourceType: SourceType; id: string }) {
  const platform = platformOf(url, sourceType);
  const Icon = platform === "LinkedIn" ? LinkedinLogo : RedditLogo;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="ev-platform" aria-describedby={id}>
      <Icon size={20} weight="fill" aria-hidden />
      <span className="sr-only">Open the {platform} post (opens in a new tab)</span>
      <span role="tooltip" id={id} className="ev-tip">
        {url}
      </span>
    </a>
  );
}
