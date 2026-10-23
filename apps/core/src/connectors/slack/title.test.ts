import { describe, expect, it } from "vitest";
import { parseTitle } from "./title.js";

describe("parseTitle", () => {
  it("从窗口标题里取频道", () => {
    expect(parseTitle("#wealth-fe (3 new items) - Longbridge - Slack")).toEqual({ channel: "#wealth-fe" });
  });

  it("私聊标题取人名", () => {
    expect(parseTitle("拂晓 - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });

  // 中文界面的真实标题：不带 #，跟一个全角「（频道）」后缀。按 # 判断会把它当成人名
  it("中文界面的频道标题（不带 # 带「（频道）」后缀）", () => {
    expect(parseTitle("team-fe-bo（频道） - Longbridge - Slack")).toEqual({ channel: "team-fe-bo" });
    // 有未读时中间会多插一段，「（频道）」不在结尾了——不能按结尾匹配
    expect(parseTitle("一起养牛（频道） - Longbridge - 1 个新项目 - Slack")).toEqual({ channel: "一起养牛" });
  });

  it("按需求建的 proj- 频道", () => {
    expect(parseTitle("proj-推荐feed页迭代与实验多组分流能力（频道） - Longbridge - Slack")).toEqual({
      channel: "proj-推荐feed页迭代与实验多组分流能力",
    });
  });

  // 左侧那些视图会整个占掉标题，认成人名只会让 Friday 去找一个叫「活动」的同事
  it("视图名不当成人名", () => {
    expect(parseTitle("活动 - Longbridge - Slack")).toEqual({});
    expect(parseTitle("私信 - Longbridge - Slack")).toEqual({});
  });

  it("私聊未读徽标是纯数字也取人名", () => {
    expect(parseTitle("拂晓 (2) - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });

  it("频道未读徽标是纯数字也取频道", () => {
    expect(parseTitle("#wealth-fe (12) - Longbridge - Slack")).toEqual({ channel: "#wealth-fe" });
  });
});
