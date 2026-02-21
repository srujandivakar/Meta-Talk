import Phaser from "phaser";
import { socket } from "../socket";
import { EVENTS, Player, MovePayload } from "@mping/shared";

const WORLD_W = 1600;
const WORLD_H = 1200;
const PLAYER_SPEED = 200;
const EMIT_INTERVAL_MS = 50;

// How close (world pixels) two players must be to trigger the Talk option.
// 150px in world space feels natural — close but not on top of each other.
const PROXIMITY_RADIUS = 150;

interface OtherPlayerSprites {
  body: Phaser.GameObjects.Arc;
  nameLabel: Phaser.GameObjects.Text;
}

/** Data passed into the scene from PhaserGame.tsx */
interface SceneInitData {
  roomId: string;
  /** Called when the nearest nearby player changes (or null = no one close) */
  onNearbyChange: (playerId: string | null) => void;
  /** Called when the local player presses T or clicks Talk */
  onTalkClicked: (targetId: string) => void;
}

export class WorldScene extends Phaser.Scene {
  private myPlayer!: Phaser.GameObjects.Arc;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  private talkKey!: Phaser.Input.Keyboard.Key;

  private otherPlayers = new Map<string, OtherPlayerSprites>();
  private lastEmitTime = 0;
  private roomId = "";
  // Temporary on-screen debug label — shows how many remote player sprites
  // exist so we can tell if socket events are firing and sprites are created.
  private debugText!: Phaser.GameObjects.Text;

  // Callbacks injected by React
  private onNearbyChange: (id: string | null) => void = () => {};
  private onTalkClicked: (id: string) => void = () => {};

  // Proximity state tracking — we only fire onNearbyChange when it CHANGES
  // (not every frame), which prevents React from re-rendering every 16ms.
  private currentNearbyId: string | null = null;

  // Proximity visual ring (drawn around the nearby player in world space)
  private proximityRing!: Phaser.GameObjects.Arc;
  // "Press [T] to Talk" hint label in world space
  private talkHint!: Phaser.GameObjects.Text;

  // Named handler refs for clean socket.off()
  private onSelfPlayer = (player: Player) => {
    // Server told us our own spawn position — snap there so we don't
    // overlap with every other player who also defaulted to center.
    this.myPlayer.setPosition(player.x, player.y);
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    if (body) body.reset(player.x, player.y);
  };
  private onRoomState = (players: Player[]) => {
    players.forEach((p) => this.spawnOtherPlayer(p));
  };
  private onPlayerJoined = (player: Player) => {
    this.spawnOtherPlayer(player);
  };
  private onPlayerMoved = (data: { id: string; x: number; y: number }) => {
    const sprites = this.otherPlayers.get(data.id);
    if (!sprites) return;
    this.tweens.add({ targets: sprites.body, x: data.x, y: data.y, duration: EMIT_INTERVAL_MS * 1.5, ease: "Linear" });
    this.tweens.add({ targets: sprites.nameLabel, x: data.x, y: data.y - 28, duration: EMIT_INTERVAL_MS * 1.5, ease: "Linear" });
  };
  private onPlayerLeft = (playerId: string) => {
    this.destroyOtherPlayer(playerId);
    // If the player who left was our nearby target, clear it
    if (this.currentNearbyId === playerId) {
      this.setNearby(null);
    }
  };

  constructor() {
    super({ key: "WorldScene" });
  }

  init(data: SceneInitData) {
    this.roomId = data.roomId;
    this.onNearbyChange = data.onNearbyChange;
    this.onTalkClicked = data.onTalkClicked;
  }

  preload() {}

  create() {
    this.drawWorld();

    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    this.myPlayer = this.add.circle(WORLD_W / 2, WORLD_H / 2, 18, 0x4ecdc4)
      .setDepth(10); // always on top of other player dots
    this.physics.add.existing(this.myPlayer);
    this.cameras.main.startFollow(this.myPlayer, true, 0.1, 0.1);

    this.add.text(0, 0, "You", {
      fontSize: "12px", color: "#ffffff", stroke: "#000000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setName("myLabel").setDepth(11); // above own dot

    // ── PROXIMITY RING ─────────────────────────────────────────
    // Drawn in world space around the closest player when in range.
    // strokeOnly = no fill so it doesn't obscure the player underneath.
    this.proximityRing = this.add
      .arc(0, 0, 26, 0, 360, false, 0x4ecdc4, 0)
      .setStrokeStyle(2, 0x4ecdc4, 0.7)
      .setVisible(false);

    // "Press [T] to Talk" hint — floats above the nearby player
    this.talkHint = this.add.text(0, 0, "[ T ] Talk", {
      fontSize: "11px",
      color: "#4ecdc4",
      stroke: "#000000",
      strokeThickness: 3,
      backgroundColor: "#00000066",
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 1).setVisible(false).setDepth(10);

    // ── INPUT ──────────────────────────────────────────────────
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.talkKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.T);

    // ── SOCKET LISTENERS (must be before JOIN_ROOM emit) ───────
    this.setupSocketListeners();
    socket.emit(EVENTS.JOIN_ROOM, this.roomId);

    // ── DEBUG OVERLAY (fixed to camera) ────────────────────────
    // Shows live remote player count and their positions.
    // Remove this once visibility is confirmed working.
    this.debugText = this.add.text(8, 8,
      "others: 0",
      { fontSize: "12px", color: "#ffff00", backgroundColor: "#000000aa",
        padding: { x: 6, y: 4 } }
    ).setScrollFactor(0).setDepth(100); // scrollFactor=0 = fixed to camera

    // Click-to-move
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.tweenPlayerTo(pointer.worldX, pointer.worldY);
    });
  }

  update(time: number, _delta: number) {
    // ── MOVEMENT ───────────────────────────────────────────────
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);

    const up    = this.cursors.up.isDown    || this.wasd.up.isDown;
    const down  = this.cursors.down.isDown  || this.wasd.down.isDown;
    const left  = this.cursors.left.isDown  || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;

    if (left)  body.setVelocityX(-PLAYER_SPEED);
    else if (right) body.setVelocityX(PLAYER_SPEED);
    if (up)    body.setVelocityY(-PLAYER_SPEED);
    else if (down)  body.setVelocityY(PLAYER_SPEED);

    if ((left || right) && (up || down)) {
      body.velocity.normalize().scale(PLAYER_SPEED);
    }

    const myLabel = this.children.getByName("myLabel") as Phaser.GameObjects.Text | null;
    if (myLabel) myLabel.setPosition(this.myPlayer.x, this.myPlayer.y - 22);

    // ── EMIT POSITION ──────────────────────────────────────────
    if (time - this.lastEmitTime > EMIT_INTERVAL_MS) {
      socket.emit(EVENTS.PLAYER_MOVE, {
        x: Math.round(this.myPlayer.x),
        y: Math.round(this.myPlayer.y),
      } as MovePayload);
      this.lastEmitTime = time;
    }

    // ── PROXIMITY CHECK ────────────────────────────────────────
    // Every frame, find the closest other player.
    // If within PROXIMITY_RADIUS → show ring + hint and notify React.
    // If none → hide ring + hint and notify React (once, not every frame).
    this.updateProximity();

    // ── TALK KEY ───────────────────────────────────────────────
    if (Phaser.Input.Keyboard.JustDown(this.talkKey) && this.currentNearbyId) {
      this.onTalkClicked(this.currentNearbyId);
    }
  }

  // ── PROXIMITY ─────────────────────────────────────────────────
  private updateProximity() {
    let closestId: string | null = null;
    let closestDist = PROXIMITY_RADIUS + 1; // start just outside range

    for (const [id, sprites] of this.otherPlayers) {
      const dx = this.myPlayer.x - sprites.body.x;
      const dy = this.myPlayer.y - sprites.body.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = id;
      }
    }

    if (closestId !== this.currentNearbyId) {
      this.setNearby(closestId);
    }

    // Update ring + hint position every frame (they move with the other player)
    if (closestId) {
      const sprites = this.otherPlayers.get(closestId)!;
      this.proximityRing.setPosition(sprites.body.x, sprites.body.y);
      this.talkHint.setPosition(sprites.body.x, sprites.body.y - 48);
    }
  }

  /** Updates the tracked nearby ID and fires React callback only on change. */
  private setNearby(id: string | null) {
    this.currentNearbyId = id;
    this.proximityRing.setVisible(id !== null);
    this.talkHint.setVisible(id !== null);
    this.onNearbyChange(id); // tell React
  }

  // ── SOCKET LISTENERS ─────────────────────────────────────────
  private setupSocketListeners() {
    socket.off(EVENTS.SELF_PLAYER,   this.onSelfPlayer);
    socket.off(EVENTS.ROOM_STATE,    this.onRoomState);
    socket.off(EVENTS.PLAYER_JOINED, this.onPlayerJoined);
    socket.off(EVENTS.PLAYER_MOVED,  this.onPlayerMoved);
    socket.off(EVENTS.PLAYER_LEFT,   this.onPlayerLeft);

    socket.on(EVENTS.SELF_PLAYER,   this.onSelfPlayer);
    socket.on(EVENTS.ROOM_STATE,    this.onRoomState);
    socket.on(EVENTS.PLAYER_JOINED, this.onPlayerJoined);
    socket.on(EVENTS.PLAYER_MOVED,  this.onPlayerMoved);
    socket.on(EVENTS.PLAYER_LEFT,   this.onPlayerLeft);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      socket.off(EVENTS.SELF_PLAYER,   this.onSelfPlayer);
      socket.off(EVENTS.ROOM_STATE,    this.onRoomState);
      socket.off(EVENTS.PLAYER_JOINED, this.onPlayerJoined);
      socket.off(EVENTS.PLAYER_MOVED,  this.onPlayerMoved);
      socket.off(EVENTS.PLAYER_LEFT,   this.onPlayerLeft);
      // Clear proximity state on shutdown so React doesn't show a stale Talk bar
      this.onNearbyChange(null);
    });
  }

  // ── HELPERS ──────────────────────────────────────────────────
  private spawnOtherPlayer(player: Player) {
    if (this.otherPlayers.has(player.id)) return;
    const colorInt = parseInt(player.color.replace("#", ""), 16);
    const body = this.add.circle(player.x, player.y, 18, colorInt)
      .setDepth(4);
    const nameLabel = this.add.text(player.x, player.y - 28, player.id.slice(0, 6), {
      fontSize: "11px", color: "#ffffff", stroke: "#000000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(9);
    this.otherPlayers.set(player.id, { body, nameLabel });
    // Update debug overlay
    const entries = Array.from(this.otherPlayers.entries())
      .map(([id, s]) => `${id.slice(0,6)} @(${Math.round(s.body.x)},${Math.round(s.body.y)})`)
      .join("\n");
    this.debugText?.setText(`others: ${this.otherPlayers.size}\n${entries}`);
  }

  private destroyOtherPlayer(playerId: string) {
    const sprites = this.otherPlayers.get(playerId);
    if (!sprites) return;
    sprites.body.destroy();
    sprites.nameLabel.destroy();
    this.otherPlayers.delete(playerId);
    this.debugText?.setText(`others: ${this.otherPlayers.size}`);
  }

  private tweenPlayerTo(x: number, y: number) {
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);
    this.tweens.add({ targets: this.myPlayer, x, y, duration: 400, ease: "Power2" });
  }

  // ── WORLD DRAWING ─────────────────────────────────────────────
  private drawWorld() {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x1a1a2e);
    graphics.fillRect(0, 0, WORLD_W, WORLD_H);
    graphics.lineStyle(1, 0x2a2a4e, 0.5);
    for (let x = 0; x <= WORLD_W; x += 80) { graphics.moveTo(x, 0); graphics.lineTo(x, WORLD_H); }
    for (let y = 0; y <= WORLD_H; y += 80) { graphics.moveTo(0, y); graphics.lineTo(WORLD_W, y); }
    graphics.strokePath();
    graphics.fillStyle(0x16213e);
    graphics.fillCircle(WORLD_W / 2, WORLD_H / 2, 160);
    graphics.lineStyle(2, 0x4ecdc4, 0.4);
    graphics.strokeCircle(WORLD_W / 2, WORLD_H / 2, 160);
    this.add.text(WORLD_W / 2, WORLD_H / 2, "Town Square", {
      fontSize: "14px", color: "#4ecdc4",
    }).setOrigin(0.5).setAlpha(0.6);
    graphics.lineStyle(3, 0x4ecdc4, 0.3);
    graphics.strokeRect(2, 2, WORLD_W - 4, WORLD_H - 4);
  }
}
