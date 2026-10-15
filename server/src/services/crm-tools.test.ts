import { describe, expect, it } from "vitest";
import {
  CRM_GET_TICKET_TOOL,
  CRM_GET_USER_TOOL,
  CRM_LIST_TICKETS_TOOL,
  createCrmStore,
  dispatchCrmTool,
} from "./crm-tools.js";

describe("crm-tools dispatch (day33)", () => {
  const store = createCrmStore();

  it("get_ticket t17: тема, план и использованные ходы в тексте", async () => {
    const r = await dispatchCrmTool(CRM_GET_TICKET_TOOL, { ticketId: 17 }, store);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Закончились бесплатные вопросы");
    expect(r.text).toContain("free");
    expect(r.text).toContain("20");
    expect(r.text).toContain("Анна");
  });

  it("get_ticket несуществующий — fail-closed ok:false", async () => {
    const r = await dispatchCrmTool(CRM_GET_TICKET_TOOL, { ticketId: 999 }, store);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/не найден/i);
  });

  it("list_tickets фильтр по статусу", async () => {
    const r = await dispatchCrmTool(CRM_LIST_TICKETS_TOOL, { status: "open" }, store);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("#17");
    expect(r.text).not.toContain("#22"); // resolved — отфильтрован
    expect(r.text).not.toContain("#19"); // pending — отфильтрован
  });

  it("get_user по email находит Бориса", async () => {
    const r = await dispatchCrmTool(
      CRM_GET_USER_TOOL,
      { email: "boris@example.com" },
      store,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Борис");
    expect(r.text).toContain("#18");
  });

  it("неизвестная тулза — ok:false", async () => {
    const r = await dispatchCrmTool("crm_delete_ticket", { ticketId: 17 }, store);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unknown crm tool/i);
  });
});

describe("crm-tools fail-closed стор", () => {
  it("битый каталог → loadError, dispatch без throw", async () => {
    const bad = createCrmStore("Z:/definitely/missing/dir");
    expect(bad.loadError).toBeTruthy();
    const r = await dispatchCrmTool(CRM_GET_TICKET_TOOL, { ticketId: 17 }, bad);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/недоступно/i);
  });
});
