import { describe, expect, it } from "vitest";
import { personNote, upsertPerson } from "./files.js";

const PEOPLE = `# 人物

## 拂晓
- 产品，负责养牛活动

## 夕瑶
- 测试
`;

describe("personNote", () => {
  it("取某人条目的第一行", () => {
    expect(personNote("拂晓", PEOPLE)).toContain("产品");
  });

  it("查不到的人返回 undefined", () => {
    expect(personNote("不存在", PEOPLE)).toBeUndefined();
  });
});

describe("upsertPerson", () => {
  it("已有的人追加一行", () => {
    let written = "";
    const line = upsertPerson("拂晓", "常催养牛活动的验收", PEOPLE, (_n, content) => { written = content; });
    expect(line).toContain("常催养牛活动的验收");
    expect(written).toContain("产品，负责养牛活动");
    expect(written).toContain("常催养牛活动的验收");
  });

  it("没有的人新建一节", () => {
    let written = "";
    upsertPerson("新人", "刚来的后端", PEOPLE, (_n, content) => { written = content; });
    expect(written).toContain("## 新人");
    expect(written).toContain("刚来的后端");
  });
});
