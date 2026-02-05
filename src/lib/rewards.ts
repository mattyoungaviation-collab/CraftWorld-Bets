export type RewardItem = {
  __typename?: "Resource" | "Badge" | "BoosterItem" | "TradePack" | "BuildingReward" | "PowerPack" | "Avatar" | string;
  symbol?: string | null;
  amount?: number | null;
  displayName?: string | null;
  badgeName?: string | null;
  description?: string | null;
  url?: string | null;
  id?: string | number | null;
  buildingType?: string | null;
  buildingSubType?: string | null;
  avatarUrl?: string | null;
};

export type FormattedReward = {
  label: string;
  sublabel?: string;
  tag: string;
  link?: string;
  linkLabel?: string;
};

export function ipfsToHttp(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}`;
  }
  return url;
}

export function formatReward(item: RewardItem): FormattedReward {
  const typeName = item.__typename ?? "Unknown";
  switch (typeName) {
    case "Resource":
      return {
        label: item.symbol || "Resource",
        sublabel: typeof item.amount === "number" ? `x${item.amount}` : undefined,
        tag: "RESOURCE",
      };
    case "Badge": {
      const badgeUrl = ipfsToHttp(item.url);
      return {
        label: item.displayName || item.badgeName || "Badge",
        sublabel: "Badge",
        tag: "BADGE",
        link: badgeUrl,
        linkLabel: "View",
      };
    }
    case "BoosterItem":
      return {
        label: "Booster",
        sublabel: [item.id, typeof item.amount === "number" ? `x${item.amount}` : undefined]
          .filter(Boolean)
          .join(" "),
        tag: "BOOSTER",
      };
    case "TradePack":
      return {
        label: "Trade Pack",
        sublabel: typeof item.amount === "number" ? `x${item.amount}` : undefined,
        tag: "TRADE PACK",
      };
    case "BuildingReward":
      return {
        label: "Building",
        sublabel: [item.buildingType, item.buildingSubType].filter(Boolean).join(" / ") || undefined,
        tag: "BUILDING",
      };
    case "PowerPack":
      return {
        label: "Power Pack",
        sublabel: [item.id, typeof item.amount === "number" ? `x${item.amount}` : undefined]
          .filter(Boolean)
          .join(" "),
        tag: "POWER",
      };
    case "Avatar": {
      const avatarLink = ipfsToHttp(item.avatarUrl);
      return {
        label: "Avatar",
        sublabel: "(available)",
        tag: "AVATAR",
        link: avatarLink,
        linkLabel: "View",
      };
    }
    default:
      return {
        label: typeName,
        sublabel: item.id ? String(item.id) : undefined,
        tag: String(typeName).toUpperCase(),
      };
  }
}
