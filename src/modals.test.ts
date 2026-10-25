import {
  DateInput,
  Modal,
  NumberInput,
  Select,
  SelectOption,
  TextInput,
} from "chat";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODAL_TEXTS,
  answerOf,
  createForm,
  formItemsOf,
  submittedOf,
} from "./modals";

const form = createForm(
  Modal({
    callbackId: "visit",
    title: "Visit",
    children: [
      TextInput({ id: "code", label: "Code", maxLength: 4 }),
      DateInput({ id: "day", label: "Day", initialValue: "2026-05-01" }),
      NumberInput({ id: "hours", label: "Hours", decimal: true }),
      Select({
        id: "room",
        label: "Room",
        options: [
          SelectOption({ label: "Blue", value: "b" }),
          SelectOption({ label: "Red", value: "r" }),
        ],
      }),
    ],
  }),
  "view",
);
const [code, day, hours, room] = form.fields;
const answer = (field: (typeof form.fields)[number], text: string) =>
  answerOf(field, form, text, DEFAULT_MODAL_TEXTS);

describe("answerOf", () => {
  it("holds a text to its maxLength, and a date to a real YYYY-MM-DD", () => {
    expect(answer(code, "AB12")).toEqual({ value: "AB12" });
    expect(answer(code, "AB123")).toHaveProperty("error");
    expect(answer(day, "2026-02-28")).toEqual({ value: "2026-02-28" });
    expect(answer(day, "2026-02-30")).toHaveProperty("error");
    expect(answer(day, "28/02/2026")).toHaveProperty("error");
  });

  it("keeps an initial value on skip, reads a decimal with a comma, and picks an option by label", () => {
    expect(answer(day, "SKIP")).toEqual({ value: "2026-05-01" });
    expect(answer(code, "skip")).toHaveProperty("error");
    expect(answer(hours, "1,5")).toEqual({ value: "1.5" });
    expect(answer(room, "red")).toEqual({ value: "r" });
    expect(answer(room, "3")).toHaveProperty("error");
  });
});

describe("formItemsOf", () => {
  it("maps only what the widget's form can show and requires", () => {
    expect(formItemsOf(form)).toBeUndefined();
    expect(formItemsOf({ ...form, pending: ["room"] })).toEqual([
      {
        type: "select",
        name: "room",
        label: "Room",
        options: [
          { label: "Blue", value: "b" },
          { label: "Red", value: "r" },
        ],
      },
    ]);
  });
});

describe("submittedOf", () => {
  it("takes exactly the fields asked, with options offered", () => {
    const asked = { ...form, pending: ["room"], values: { code: "AB12" } };
    expect(submittedOf(asked, [{ name: "room", value: "r" }])).toEqual({
      code: "AB12",
      room: "r",
    });
    expect(submittedOf(asked, [{ name: "room", value: "x" }])).toBeUndefined();
    expect(
      submittedOf(asked, [
        { name: "room", value: "r" },
        { name: "code", value: "ZZ" },
      ]),
    ).toBeUndefined();
    expect(submittedOf(asked, "room=r")).toBeUndefined();
  });
});
