import { expect, it } from "vitest";
import {
  getPowerConfirmation,
  requestPowerConfirmation,
  settlePowerConfirmation,
  subscribePowerConfirmation,
} from "./powerConfirm";

it("opens a power confirmation and resolves true when confirmed", async () => {
  const changes: Array<string | null> = [];
  const unsubscribe = subscribePowerConfirmation(() => {
    changes.push(getPowerConfirmation()?.title ?? null);
  });

  const result = requestPowerConfirmation({ title: "Hey, are you sure?", message: "Delete it?" });

  expect(getPowerConfirmation()).toMatchObject({
    title: "Hey, are you sure?",
    message: "Delete it?",
    shortcutLabel: "⌘W",
  });

  settlePowerConfirmation(true);

  await expect(result).resolves.toBe(true);
  expect(getPowerConfirmation()).toBeNull();
  expect(changes).toEqual(["Hey, are you sure?", null]);

  unsubscribe();
});

it("resolves false when canceled", async () => {
  const result = requestPowerConfirmation({ title: "Hey, are you sure?", message: "Delete it?" });

  settlePowerConfirmation(false);

  await expect(result).resolves.toBe(false);
  expect(getPowerConfirmation()).toBeNull();
});

// useSyncExternalStore contract: an unstable snapshot makes React re-render
// forever and blank the app the moment the dialog opens.
it("returns the same snapshot object until the confirmation changes", async () => {
  const result = requestPowerConfirmation({ title: "Hey, are you sure?", message: "Delete it?" });

  expect(getPowerConfirmation()).toBe(getPowerConfirmation());

  settlePowerConfirmation(false);
  await expect(result).resolves.toBe(false);
});
