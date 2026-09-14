import { describe, expect, it } from "vitest";
import { classifyNoise, meaningfulText } from "./noise.js";

const noise = (t: string) => classifyNoise(t).noise;

describe("噪音过滤", () => {
  it("没有文字内容的挡掉：空、纯 @、纯表情", () => {
    expect(noise("")).toBe(true);
    expect(noise("   ")).toBe(true);
    expect(noise("<@U092UA21P6D>")).toBe(true);
    expect(noise("<@U1> <@U2> <@U3>")).toBe(true);
    expect(noise(":ok_hand::skin-tone-2:")).toBe(true);
    expect(noise("<@U1> :frogbless:")).toBe(true);
    expect(noise("👍")).toBe(true);
    expect(noise("。。。")).toBe(true);
  });

  it("纯应答挡掉", () => {
    for (const t of ["好", "好的", "ok", "OK", "收到", "哈哈哈", "嗯嗯", "辛苦了", "+1", "好的。", "行~"]) {
      expect(noise(t), t).toBe(true);
    }
    expect(noise("<@U1> 好的")).toBe(true);
  });

  it("有实质内容的一律放行", () => {
    for (const t of [
      "<@U1> 你看看志华遗留的这个问题",
      "抽空验收问题改一改 <@U1> <@U2>",
      "好的，我下午改",           // 带了承诺，不是纯应答
      "改好了",                   // 短但是结论
      "没问题",
      "现在还是他负责是吧",
      "h",                        // 判不准的短句放行，不猜
      "<https://project.larksuite.com/x/1>", // 只有链接也是有信息的
      "<@U1> <https://b-1.com/err> 报错了",
    ]) {
      expect(noise(t), t).toBe(false);
    }
  });

  it("@ 一大群人不算噪音", () => {
    // 用库里的历史数据验过：@ 六人以上的消息里要回的 6 条、不用回的 10 条，
    // 按人数挡会误杀六件真事
    expect(noise("<@U1> <@U2> <@U3> <@U4> <@U5> <@U6> 技术评审了，看下文档")).toBe(false);
  });

  it("meaningfulText 保留链接占位，去掉 @ 与 emoji", () => {
    expect(meaningfulText("<@U1> 看下 <https://a.com|文档> :smile:")).toBe("看下 链接");
    expect(meaningfulText("<!channel> 发布了")).toBe("发布了");
  });
});
