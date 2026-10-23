/**
 * 收件前的噪音过滤。挡掉的消息不入库、用户完全看不到，所以只挡客观特征明确的，
 * 拿不准一律放行——漏一条噪音只是多看一眼，错挡一条是真丢事情。
 */

/** Slack 标记：<@U123>、<#C123|name>、<!channel>、<url|text> */
const MENTION = /<[@#!][^>]*>/g;
const LINK = /<(https?:\/\/[^|>]+)(\|[^>]*)?>/g;
const EMOJI_CODE = /:[a-z0-9_+-]+:/gi;
/** 真·emoji 字符（含变体选择符与零宽连接） */
const EMOJI_CHAR = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** 去掉 @、emoji、空白后剩下的实际内容。链接留一个占位符，因为「只发了个链接」是有信息的。 */
export function meaningfulText(raw: string): string {
  return raw
    .replace(LINK, " 链接 ")
    .replace(MENTION, " ")
    .replace(EMOJI_CODE, " ")
    .replace(EMOJI_CHAR, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 极短的纯应答。只认完整匹配的固定说法，不做「长度小于 N 就算」——
 * 「改好了」「没问题」这种短句也可能是要跟进的结论。
 */
const ACK = new Set([
  "好", "好的", "好哒", "好滴", "好吧", "行", "行吧", "可以", "嗯", "嗯嗯", "哦", "噢", "懂了", "明白", "知道了",
  "收到", "收到收到", "了解", "ok", "okay", "okk", "k", "yes", "no", "thx", "thanks", "谢谢", "多谢", "辛苦了", "辛苦",
  "是的", "对", "对的", "没错", "是", "有", "在", "在的", "哈哈", "哈哈哈", "666", "赞", "同意", "+1",
]);

export interface NoiseVerdict {
  noise: boolean;
  /** 挡掉的原因，只用来打日志，方便回头核对规则挡了什么 */
  why?: string;
}

export function classifyNoise(text: string): NoiseVerdict {
  const body = meaningfulText(text);
  // 一个字都不剩：纯图片、纯表情、纯 @。Friday 拿它没有任何可依据的内容
  if (!body) return { noise: true, why: "没有文字内容" };
  const plain = body.toLowerCase().replace(/[。，!！?？~、.,\s]/g, "");
  if (!plain) return { noise: true, why: "只有标点" };
  if (ACK.has(plain)) return { noise: true, why: `纯应答「${body}」` };
  return { noise: false };
}

// 试过按「@ 的人数」挡群发广播，用库里的历史数据一验：@ 六人以上的消息里
// 要回的 6 条、不用回的 10 条——挡掉会误杀六件真事。这个代价太高，不做。
