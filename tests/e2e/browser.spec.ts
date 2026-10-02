import { test, expect, type Browser, type Page } from "@playwright/test";
import { KAPULA_METADATA_MAX_LENGTH } from "@kapula/protocol";
import { devLogin, hostCall } from "./ws-utils";
import { TestDriver } from "./test-driver";


const TANK_CONFIG = {
  game: "Tank Test",
  minPlayers: 1,
  maxPlayers: 4,
  schemas: [
    {
      id: "tank",
      name: "Tank",
      controls: [
        { type: "joystick", id: "drive" },
        { type: "button", id: "fire", label: "Fire" },
        { type: "button", id: "boost", label: "Boost" },
      ],
    },
  ],
};

/** Fresh host user per test run: sessions are one-per-user. */
const uniqueEmail = () =>
  `gamepad-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

const createHostSession = async (page: Page): Promise<string> => {
  await page.goto(`/auth/dev-login?email=${encodeURIComponent(uniqueEmail())}`);
  await page.goto("/");
  await page.getByTestId("create-session-button").click();
  const setupCode = (await page.getByTestId("setup-code").textContent())?.trim();
  expect(setupCode).toBeTruthy();
  return setupCode!;
};

const joinAsPlayer = async (
  browser: Browser,
  joinCode: string,
  name: string,
): Promise<Page> => {
  // newContext() does not inherit the project's use options; the dev stack
  // may run on a self-signed certificate.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`/join/${joinCode}`);
  // Joining takes only the code; the server assigns a name ("Player N") that
  // the player then customizes in the lobby.
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("ready-toggle")).toBeVisible();
  await page.getByTestId("player-name-input").fill(name);
  await page.getByTestId("player-name-input").press("Enter");
  await expect(page.getByTestId("player-list")).toContainText(name);
  return page;
};

test("full session flow: setup, lobby, input relay, pause, end", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);

  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  expect(setup.joinCode).toHaveLength(6);
  expect(setup.joinUrl).toContain(`join/${setup.joinCode}`);
  // The session was created without metadata, so the field stays absent.
  expect(setup.metadata).toBeUndefined();

  // The host dashboard shows the join code to share once the driver claims
  // the session. The host is NOT joined as a player.
  await expect(page.getByTestId("join-code")).toHaveText(setup.joinCode);

  const driver = new TestDriver();
  await driver.connect(setup.wsPath);
  const snap = await driver.waitFor((m) => m.type === "snapshot");
  expect((snap.snapshot as { players: unknown[] }).players).toHaveLength(0);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await driver.waitFor(
    (m) =>
      m.type === "player_updated" &&
      (m.player as { name: string }).name === "Alice",
  );
  await expect(page.getByTestId("player-list")).toContainText("Alice");

  const bob = await joinAsPlayer(browser, setup.joinCode, "Bob");

  // Players can try the controller locally while still in the lobby; the
  // trial renders the real controls but sends nothing to the driver.
  await alice.getByTestId("try-controller").click();
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  await alice.getByTestId("control-fire").click();
  await alice.getByTestId("close-try-controller").click();
  await expect(alice.getByTestId("control-fire")).not.toBeVisible();
  await expect(alice.getByTestId("ready-toggle")).toBeVisible();

  await alice.getByTestId("ready-toggle").click();
  await bob.getByTestId("ready-toggle").click();
  await driver.waitFor(
    (m) =>
      m.type === "player_updated" &&
      (m.player as { name: string; ready: boolean }).name === "Bob" &&
      (m.player as { ready: boolean }).ready,
  );

  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  await expect(bob.getByTestId("control-fire")).toBeVisible();

  // Button edges arrive as separate frames (press, then release).
  await alice.getByTestId("control-fire").click();
  const press = await driver.waitFor(
    (m) =>
      m.type === "input" &&
      (m.controls as Record<string, unknown>).fire === true,
  );
  expect(typeof press.seq).toBe("number");
  await driver.waitFor(
    (m) =>
      m.type === "input" &&
      (m.controls as Record<string, unknown>).fire === false &&
      (m.seq as number) > (press.seq as number),
  );

  // Dragging the joystick produces a normalized axis frame.
  const pad = alice.getByTestId("control-drive");
  const box = (await pad.boundingBox())!;
  await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await alice.mouse.down();
  await alice.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, {
    steps: 3,
  });
  await driver.waitFor((m) => {
    if (m.type !== "input") return false;
    const drive = (m.controls as Record<string, { x?: number }>).drive;
    return typeof drive === "object" && (drive?.x ?? 0) > 0.3;
  });
  await alice.mouse.up();

  driver.send({ type: "pause" });
  await expect(alice.getByText("Paused")).toBeVisible();
  driver.send({ type: "resume" });
  await expect(alice.getByText("Paused")).not.toBeVisible();

  driver.send({ type: "end" });
  // An ended session is not a screen: the player is straight back on the
  // start page with a one-liner and the join form.
  await expect(alice.getByText("The session ended. Thanks for playing!")).toBeVisible();
  await expect(alice.getByTestId("join-code-input")).toBeVisible();
  // The host dashboard falls back to the create view, saying why.
  await expect(page.getByTestId("create-session-button")).toBeVisible();
  await expect(page.getByTestId("session-ended-note")).toContainText("ended");

  driver.close();
});

test("duplicate names are rejected, case-insensitively", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode);

  await joinAsPlayer(browser, setup.joinCode, "Sam");

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const dupe = await context.newPage();
  await dupe.goto(`/join/${setup.joinCode}`);
  await dupe.getByTestId("join-button").click();
  await expect(dupe.getByTestId("ready-toggle")).toBeVisible();

  // Renaming to a taken name (case-insensitively) is rejected in the lobby.
  await dupe.getByTestId("player-name-input").fill("sam");
  await dupe.getByTestId("player-name-input").press("Enter");
  await expect(dupe.getByTestId("session-notice")).toContainText("name");

  // A unique name goes straight through.
  await dupe.getByTestId("player-name-input").fill("Sam II");
  await dupe.getByTestId("player-name-input").press("Enter");
  await expect(dupe.getByTestId("player-list")).toContainText("Sam II");
});

test("players silently rejoin after a reload; driver loss pauses the game", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();

  // The stored player token puts the reloaded tab straight back in the game.
  await alice.reload();
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  await expect(alice.getByTestId("player-name-input")).not.toBeVisible();

  // Killing the driver mid-game pauses instead of dropping input silently.
  driver.close();
  await expect(alice.getByText("Paused")).toBeVisible();

  // A reconnected driver resumes explicitly.
  const driver2 = new TestDriver();
  await driver2.connect(setup.wsPath);
  await driver2.waitFor((m) => m.type === "snapshot");
  driver2.send({ type: "resume" });
  await expect(alice.getByText("Paused")).not.toBeVisible();

  driver2.send({ type: "end" });
  driver2.close();
});

test("an ended session is discarded: returning later offers the join form", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();

  driver.send({ type: "end" });
  await expect(alice.getByTestId("join-code-input")).toBeVisible();
  driver.close();

  // Alice just comes back to the app later. The ended session's credential
  // was discarded the moment the end arrived, so she gets the join form, not
  // a "game in progress" card.
  await alice.goto("/");
  await expect(alice.getByTestId("join-code-input")).toBeVisible();
  await expect(alice.getByTestId("open-controller")).not.toBeVisible();
});

test("a session ended while the player was away is discarded on return", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  // Alice parks on the landing page: her controller socket is closed, so
  // she will not see the end happen live — the stale credential card shows.
  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.goto("/");
  await expect(alice.getByTestId("open-controller")).toBeVisible();

  driver.send({ type: "end" });
  // The host dashboard falling back to the create view confirms the end
  // has been processed server-side.
  await expect(page.getByTestId("create-session-button")).toBeVisible();
  driver.close();

  // The landing page verifies the stored credential with the server before
  // showing the card: on her next visit there is no "you are in a game"
  // note for the ended session — only the join form.
  await alice.goto("/");
  await expect(alice.getByTestId("join-code-input")).toBeVisible();
  await expect(alice.getByTestId("open-controller")).not.toBeVisible();
});

test("the host is not auto-joined, and a player can leave the lobby", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);
  const snap = await driver.waitFor((m) => m.type === "snapshot");

  // Creating and claiming the session put nobody in the lobby: the host can
  // play, but only by joining with the code like anyone else — their landing
  // page still offers the join form next to the session dashboard.
  expect((snap.snapshot as { players: unknown[] }).players).toHaveLength(0);
  await expect(page.getByTestId("join-code")).toHaveText(setup.joinCode);
  await expect(page.getByTestId("join-code-input")).toBeVisible();
  await expect(page.getByTestId("ready-toggle")).not.toBeVisible();

  // A joined player has a Leave control in the lobby; using it frees the
  // slot (player_left, not a reconnectable disconnect) and returns the
  // device to the landing page.
  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("leave-session").click();
  await driver.waitFor((m) => m.type === "player_left");
  await expect(alice.getByTestId("join-code-input")).toBeVisible();
  expect(
    driver.messages.filter((m) => m.type === "player_disconnected"),
  ).toHaveLength(0);

  driver.send({ type: "end" });
  driver.close();
});

test("host metadata is delivered to the driver in the setup response", async ({
  page,
  request,
}) => {
  // A launcher app would pass e.g. game configuration this way; the server
  // treats it as opaque text.
  const metadata = JSON.stringify({ rounds: 5, roundTime: 90 });

  await page.goto(`/auth/dev-login?email=${encodeURIComponent(uniqueEmail())}`);
  await page.goto("/");
  await page.getByText("Add metadata for the game (optional)").click();
  await page.getByTestId("session-metadata-input").fill(metadata);
  await page.getByTestId("create-session-button").click();
  const setupCode = (await page.getByTestId("setup-code").textContent())?.trim();
  expect(setupCode).toBeTruthy();

  const setup = await TestDriver.setup(request, setupCode!, TANK_CONFIG);
  expect(setup.metadata).toBe(metadata);

  // Clean up so later runs of this host are not blocked by an active session.
  await page.getByTestId("end-session-button").click();
  await page.getByTestId("confirm-end-session").click();
});

test("oversized session metadata is rejected at creation", async ({
  request,
}) => {
  await devLogin(request, uniqueEmail());
  const result = await hostCall(request, "createSession", {
    metadata: "x".repeat(KAPULA_METADATA_MAX_LENGTH + 1),
  });
  expect(result.error).toBeTruthy();
  expect(result.error.data.code).toBe("BAD_REQUEST");
});

/**
 * A "relative" pad is the one control whose value cannot be read off its
 * position on screen: the touch-down point becomes that touch's neutral, so
 * the same pixel means different things on different touches. Driven through
 * the help page's demo, which runs the real Controller and input pipeline and
 * prints the frame a driver would receive.
 */
// The debug presets' fixed identity; any UUID a driver ships works the same.
const TANK_CONFIG_WITH_IDENTITY = {
  ...TANK_CONFIG,
  driverAppUuid: "7d3a2c1e-5b64-4f0a-9c8d-2e1f0b6a4d95",
};

const center = async (page: Page, testId: string) => {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

test("players edit their layout from the in-game menu; edits persist per game", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG_WITH_IDENTITY);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  const before = await center(alice, "control-fire");

  // The menu opens any time from the header; with one schema there is no
  // picker, and with a driver identity edits are remembered (no hint).
  await alice.getByTestId("open-menu").click();
  await expect(alice.getByTestId("session-menu")).toBeVisible();
  await expect(
    alice.getByTestId("session-menu").getByText("Menu", { exact: true }),
  ).toBeVisible();
  await expect(alice.getByTestId("layout-not-persisted-hint")).not.toBeVisible();
  await expect(alice.getByTestId("reset-layout")).toBeDisabled();
  await alice.getByTestId("close-menu").click();
  await expect(alice.getByTestId("session-menu")).not.toBeVisible();

  // Edit: drag the fire button up and left, grow it with the header's +.
  await alice.getByTestId("open-menu").click();
  await alice.getByTestId("edit-layout").click();
  await expect(alice.getByTestId("layout-editor")).toBeVisible();
  const handle = await center(alice, "edit-fire");
  await alice.mouse.move(handle.x, handle.y);
  await alice.mouse.down();
  await alice.mouse.move(handle.x - 120, handle.y - 60, { steps: 6 });
  await alice.mouse.up();
  await expect(alice.getByTestId("edit-fire")).toHaveAttribute("data-selected", "true");
  const dragged = await center(alice, "edit-fire");
  expect(dragged.x).toBeLessThan(handle.x - 100);
  expect(dragged.y).toBeLessThan(handle.y - 40);
  await alice.getByTestId("layout-bigger").click();
  const grown = await center(alice, "edit-fire");
  expect(grown.box.width).toBeGreaterThan(dragged.box.width * 1.1);

  // Holding still on the (full) drive stick swaps it to a relative pad; the
  // held finger then drags nothing.
  await expect(alice.getByTestId("control-drive")).toHaveAttribute("data-mode", "full");
  const stick = await center(alice, "edit-drive");
  await alice.mouse.move(stick.x, stick.y);
  await alice.mouse.down();
  await expect(alice.getByTestId("control-drive")).toHaveAttribute("data-mode", "relative");
  await alice.mouse.move(stick.x + 60, stick.y, { steps: 3 });
  await alice.mouse.up();
  const stickAfterHold = await center(alice, "edit-drive");
  expect(Math.abs(stickAfterHold.x - stick.x)).toBeLessThan(2);
  await alice.getByTestId("layout-editor-done").click();

  // Back in the game the control sits where it was put and still works.
  await expect(alice.getByTestId("layout-editor")).not.toBeVisible();
  await expect(alice.getByTestId("control-drive")).toHaveAttribute("data-mode", "relative");
  const after = await center(alice, "control-fire");
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.box.width).toBeGreaterThan(before.box.width * 1.1);
  await alice.mouse.move(after.x, after.y);
  await alice.mouse.down();
  await driver.waitFor(
    (m) => m.type === "input" && (m.controls as Record<string, unknown>).fire === true,
  );
  await alice.mouse.up();

  // The edit survives a reload: it is filed under the driver's identity.
  await alice.reload();
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  await expect(alice.getByTestId("control-drive")).toHaveAttribute("data-mode", "relative");
  const reloaded = await center(alice, "control-fire");
  expect(Math.abs(reloaded.x - after.x)).toBeLessThan(2);
  expect(Math.abs(reloaded.box.width - after.box.width)).toBeLessThan(2);

  // Reset from the menu puts the automatic layout back.
  await alice.getByTestId("open-menu").click();
  await expect(alice.getByTestId("reset-layout")).toBeEnabled();
  await alice.getByTestId("reset-layout").click();
  await expect(alice.getByTestId("reset-layout")).toBeDisabled();
  await alice.getByTestId("close-menu").click();
  await expect(alice.getByTestId("control-drive")).toHaveAttribute("data-mode", "full");
  const restored = await center(alice, "control-fire");
  expect(Math.abs(restored.x - before.x)).toBeLessThan(2);
  expect(Math.abs(restored.box.width - before.box.width)).toBeLessThan(2);

  // A driver pause forces the menu open without a way to close it; editing
  // is still offered there.
  driver.send({ type: "pause" });
  await expect(alice.getByText("Paused")).toBeVisible();
  await expect(alice.getByTestId("close-menu")).not.toBeVisible();
  await expect(alice.getByTestId("open-menu")).toBeDisabled();
  await expect(alice.getByTestId("edit-layout")).toBeVisible();
  driver.send({ type: "resume" });
  await expect(alice.getByText("Paused")).not.toBeVisible();
  await expect(alice.getByTestId("session-menu")).not.toBeVisible();

  driver.send({ type: "end" });
  driver.close();
});

test("players edit and align the layout from the lobby's trial controller", async ({
  page,
  browser,
  request,
}) => {
  // The trial is where a layout that feels wrong is noticed, and the lobby
  // is the calm moment to fix it — the same editor, on the same stored
  // layout, without a game running.
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG_WITH_IDENTITY);
  const driver = new TestDriver();
  await driver.connect(setup.wsUrl);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("try-controller").click();
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  // Where the engine puts the button before anyone edits anything.
  const engineDefault = await center(alice, "control-fire");
  // With a driver identity, edits are remembered — no hint in the trial.
  await expect(
    alice.getByTestId("trial-layout-not-persisted-hint"),
  ).not.toBeVisible();

  await alice.getByTestId("trial-edit-layout").click();
  await expect(alice.getByTestId("layout-editor")).toBeVisible();

  // Drag the fire button to just beside the drive stick's center line: it
  // must click onto it exactly, and say so with a guide.
  const stick = await center(alice, "edit-drive");
  const fire = await center(alice, "edit-fire");
  await alice.mouse.move(fire.x, fire.y);
  await alice.mouse.down();
  await alice.mouse.move(fire.x, stick.y - 4, { steps: 8 });
  await expect(alice.getByTestId("layout-guide-y")).toBeVisible();
  await alice.mouse.up();
  // The guide is a drag-time aid; it goes when the finger lifts.
  await expect(alice.getByTestId("layout-guide-y")).not.toBeVisible();
  const snapped = await center(alice, "edit-fire");
  expect(Math.abs(snapped.y - stick.y)).toBeLessThan(2);

  // Snapping attracts, it does not glue: dragging well clear leaves the
  // control where the finger put it.
  await alice.mouse.move(snapped.x, snapped.y);
  await alice.mouse.down();
  await alice.mouse.move(snapped.x, snapped.y - 60, { steps: 8 });
  await alice.mouse.up();
  const free = await center(alice, "edit-fire");
  expect(Math.abs(free.y - stick.y)).toBeGreaterThan(20);

  await alice.getByTestId("layout-editor-done").click();
  // Back in the trial, playing the layout that was just edited.
  await expect(alice.getByTestId("layout-editor")).not.toBeVisible();
  const tried = await center(alice, "control-fire");
  expect(Math.abs(tried.y - free.y)).toBeLessThan(2);

  // And it is the same layout the game will use. Not pixel-for-pixel: boxes
  // are stored relative to the controller's own box, and the trial's header
  // is a few pixels taller than the game's, so the same stored layout lands
  // a few pixels apart — by design (see layout-override.ts).
  await alice.getByTestId("close-try-controller").click();
  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  const inGame = await center(alice, "control-fire");
  expect(Math.abs(inGame.y - free.y)).toBeLessThan(12);
  expect(Math.abs(inGame.y - engineDefault.y)).toBeGreaterThan(20);

  driver.send({ type: "end" });
  driver.close();
});

test("without a driver identity the menu says edits are not remembered", async ({
  page,
  browser,
  request,
}) => {
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, TANK_CONFIG);
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");
  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();

  await alice.getByTestId("open-menu").click();
  await expect(alice.getByTestId("layout-not-persisted-hint")).toBeVisible();

  driver.send({ type: "end" });
  driver.close();
});

test("a driver can pin controls by x/y and lock the layout against editing", async ({
  page,
  browser,
  request,
}) => {
  // An exact layout: every control positioned as a percentage of the
  // controller box, and `disallowLayoutCustomization` so no player edit —
  // live or stored from an earlier session — can move them.
  const setupCode = await createHostSession(page);
  const setup = await TestDriver.setup(request, setupCode, {
    ...TANK_CONFIG_WITH_IDENTITY,
    disallowLayoutCustomization: true,
    schemas: [
      {
        id: "tank",
        name: "Tank",
        orientation: "landscape",
        controls: [
          { type: "joystick", id: "drive", x: 20, y: 60 },
          { type: "button", id: "fire", label: "Fire", x: 60, y: 50 },
          { type: "button", id: "boost", label: "Boost", x: 90, y: 50 },
        ],
      },
    ],
  });
  const driver = new TestDriver();
  await driver.connect(setup.wsPath);

  const alice = await joinAsPlayer(browser, setup.joinCode, "Alice");

  // The lobby trial shows the layout but offers no editor and no hint.
  await alice.getByTestId("try-controller").click();
  await expect(alice.getByTestId("control-fire")).toBeVisible();
  await expect(alice.getByTestId("trial-edit-layout")).not.toBeVisible();
  await expect(
    alice.getByTestId("trial-layout-not-persisted-hint"),
  ).not.toBeVisible();
  await alice.getByTestId("close-try-controller").click();

  await alice.getByTestId("ready-toggle").click();
  driver.send({ type: "start" });
  await expect(alice.getByTestId("control-fire")).toBeVisible();

  // Same y percentage → same row; x 60 and 90 → 30% of the controller's
  // width apart, and the width is the page's (no safe-area insets here).
  const fire = await center(alice, "control-fire");
  const boost = await center(alice, "control-boost");
  const width = alice.viewportSize()!.width;
  expect(Math.abs(fire.y - boost.y)).toBeLessThan(2);
  expect(Math.abs(boost.x - fire.x - width * 0.3)).toBeLessThan(4);

  // The in-game menu (open or forced by a pause) has no layout buttons.
  await alice.getByTestId("open-menu").click();
  await expect(alice.getByTestId("session-menu")).toBeVisible();
  await expect(alice.getByTestId("edit-layout")).not.toBeVisible();
  await expect(alice.getByTestId("reset-layout")).not.toBeVisible();
  await expect(alice.getByTestId("layout-not-persisted-hint")).not.toBeVisible();
  await alice.getByTestId("close-menu").click();
  driver.send({ type: "pause" });
  await expect(alice.getByText("Paused")).toBeVisible();
  await expect(alice.getByTestId("edit-layout")).not.toBeVisible();
  driver.send({ type: "resume" });
  // Press only once the phone has left the pause: a press that lands while
  // the controller is still disabled never reaches the driver.
  await expect(alice.getByText("Paused")).not.toBeVisible();
  await expect(alice.getByTestId("control-fire")).toBeEnabled();

  // The controls still work where they were pinned.
  await alice.mouse.move(fire.x, fire.y);
  await alice.mouse.down();
  await driver.waitFor(
    (m) => m.type === "input" && (m.controls as Record<string, unknown>).fire === true,
  );
  await alice.mouse.up();

  driver.send({ type: "end" });
  driver.close();
});
