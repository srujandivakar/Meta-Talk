import Phaser from "phaser";
import { socket } from "../socket";
import { EVENTS, Player, MovePayload } from "@mping/shared";

// ── WORLD CONSTANTS ────────────────────────────────────────────
const WORLD_W       = 2400;
const WORLD_H       = 1800;
const PLAYER_SPEED  = 220;
const EMIT_INTERVAL_MS = 50;
const PROXIMITY_RADIUS = 150;

// Isometric tile unit — half-width of one tile
const T = 40;

// Colour palette — low-poly day island
const C = {
  bg:          0x0d1b2a,  // night sky
  // Terrain
  grass:       0x3db348,
  grassAlt:    0x35a040,
  beach:       0xd4b064,
  beachAlt:    0xc4a055,
  road:        0x8a7f6e,
  roadAlt:     0x776d5e,
  water:       0x2b8fd8,
  waterAlt:    0x2280c8,
  waterShine:  0x7dd4ff,
  // Island slab sides
  earthFront:  0x7a5a20,
  earthRight:  0x614810,
  earthBottom: 0x3d2808,
  // Buildings (white/grey low-poly)
  wallA:       0xe8ecf0,
  wallB:       0xced8e0,
  roofA:       0xb2bec8,
  roofB:       0x9aaab8,
  windows:     0x4a8fc0,
  // Trees
  treeA:       0x2a6018,
  treeB:       0x347820,
  treeC:       0x409428,
  treeTrunk:   0x5c3b10,
  // Accent
  teal:        0x22c5a0,  // player / proximity only
  gold:        0xf0c040,
} as const;

interface OtherPlayerSprites {
  body:      Phaser.GameObjects.Container;
  nameLabel: Phaser.GameObjects.Text;
  leftLeg:   Phaser.GameObjects.Graphics;
  rightLeg:  Phaser.GameObjects.Graphics;
  leftArm:   Phaser.GameObjects.Graphics;
  rightArm:  Phaser.GameObjects.Graphics;
  walkCycle: number;
  color:     number;
}

interface SceneInitData {
  roomId: string;
  onNearbyChange: (playerId: string | null) => void;
  onTalkClicked:  (targetId: string) => void;
}

export class WorldScene extends Phaser.Scene {
  private myPlayer!:    Phaser.GameObjects.Container;
  private myLeftLeg!:   Phaser.GameObjects.Graphics;
  private myRightLeg!:  Phaser.GameObjects.Graphics;
  private myLeftArm!:   Phaser.GameObjects.Graphics;
  private myRightArm!:  Phaser.GameObjects.Graphics;
  private myWalkCycle = 0;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up:    Phaser.Input.Keyboard.Key;
    down:  Phaser.Input.Keyboard.Key;
    left:  Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  private talkKey!: Phaser.Input.Keyboard.Key;

  private otherPlayers   = new Map<string, OtherPlayerSprites>();
  private lastEmitTime   = 0;
  private roomId         = "";

  private onNearbyChange: (id: string | null) => void = () => {};
  private onTalkClicked:  (id: string) => void        = () => {};
  private currentNearbyId: string | null = null;

  private proximityRing!: Phaser.GameObjects.Graphics;
  private talkHint!:      Phaser.GameObjects.Text;

  // Animated layers
  private fountainGraphics!: Phaser.GameObjects.Graphics;
  private ambientLights!:    Phaser.GameObjects.Graphics;
  private waterGraphics!:    Phaser.GameObjects.Graphics;
  private fountainT = 0;
  private ambientT  = 0;
  private waterT    = 0;

  // ── SOCKET HANDLERS ────────────────────────────────────────
  private onSelfPlayer = (player: Player) => {
    this.myPlayer.setPosition(player.x, player.y);
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    if (body) body.reset(player.x, player.y);
  };
  private onRoomState    = (players: Player[]) => players.forEach(p => this.spawnOtherPlayer(p));
  private onPlayerJoined = (player: Player)    => this.spawnOtherPlayer(player);
  private onPlayerMoved  = (data: { id: string; x: number; y: number }) => {
    const sprites = this.otherPlayers.get(data.id);
    if (!sprites) return;
    
    // Cancel any existing movement tween to prevent conflicts
    this.tweens.killTweensOf(sprites.body);
    this.tweens.killTweensOf(sprites.nameLabel);
    
    this.tweens.add({
      targets: sprites.body, x: data.x, y: data.y,
      duration: EMIT_INTERVAL_MS * 1.5, ease: "Linear",
      onUpdate: (tween) => {
        sprites.body.setDepth(Math.round(sprites.body.y));
        sprites.nameLabel.setDepth(Math.round(sprites.body.y) + 1);
        // Use tween progress (0 to 1) for smooth animation regardless of frame rate
        const progress = tween.progress;
        sprites.walkCycle = progress * Math.PI * 4; // 2 full walking cycles per move
        this.drawLegs(sprites.leftLeg, sprites.rightLeg, sprites.leftArm, sprites.rightArm, sprites.walkCycle, sprites.color);
      },
      onComplete: () => {
        sprites.walkCycle = 0;
        this.drawLegs(sprites.leftLeg, sprites.rightLeg, sprites.leftArm, sprites.rightArm, 0, sprites.color);
      },
    });
    this.tweens.add({
      targets: sprites.nameLabel, x: data.x, y: data.y - 62,
      duration: EMIT_INTERVAL_MS * 1.5, ease: "Linear",
    });
  };
  private onPlayerLeft = (playerId: string) => {
    this.destroyOtherPlayer(playerId);
    if (this.currentNearbyId === playerId) this.setNearby(null);
  };

  constructor() { super({ key: "WorldScene" }); }

  init(data: SceneInitData) {
    this.roomId         = data.roomId;
    this.onNearbyChange = data.onNearbyChange;
    this.onTalkClicked  = data.onTalkClicked;
  }

  preload() {
    // Google Fonts
    if (!document.getElementById("mping-gfonts")) {
      const link = document.createElement("link");
      link.id    = "mping-gfonts";
      link.rel   = "stylesheet";
      link.href  = "https://fonts.googleapis.com/css2?family=Nunito:wght@400;700&family=Exo+2:wght@300;400&display=swap";
      document.head.appendChild(link);
    }
    // Particle textures
    const mk = (key: string, col: number, r: number) => {
      const g = this.make.graphics({ x: 0, y: 0 });
      g.fillStyle(col, 1); g.fillCircle(r, r, r);
      g.generateTexture(key, r * 2, r * 2); g.destroy();
    };
    mk("pt_water",  0x7dd4ff, 5);
    mk("pt_white",  0xffffff, 4);
    mk("pt_foam",   0xddf4ff, 3);
    mk("pt_leaf",   0x3db348, 3);
  }

  create() {
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // Static world layers (drawn once)
    this.drawBackground();
    this.drawIslandBase();
    this.drawFloorTiles();
    this.drawRoads();
    this.drawZoneLabels();
    this.drawBuildings();
    this.drawTrees();

    // Lake splash particles
    {
      const lakeCenter = this.isoPos(6, -7);
      this.add.particles(lakeCenter.x, lakeCenter.y, "pt_water", {
        speed:     { min: 8, max: 30 },
        scale:     { start: 0.55, end: 0 },
        alpha:     { start: 0.7, end: 0 },
        lifespan:  { min: 1200, max: 2800 },
        frequency: 80,
        blendMode: "NORMAL",
        quantity:  1,
        gravityY:  -4,
      }).setDepth(4);
      this.add.particles(lakeCenter.x, lakeCenter.y, "pt_foam", {
        speed:     { min: 3, max: 12 },
        scale:     { start: 0.4, end: 0 },
        alpha:     { start: 0.5, end: 0 },
        lifespan:  { min: 1800, max: 3200 },
        frequency: 200,
        blendMode: "NORMAL",
        quantity:  1,
        gravityY:  -2,
      }).setDepth(4);
    }
    // Leaf/wind particles in park zone
    {
      const parkCenter = this.isoPos(-10, -9);
      this.add.particles(parkCenter.x, parkCenter.y, "pt_leaf", {
        speed:     { min: 6, max: 22 },
        scale:     { start: 0.5, end: 0 },
        alpha:     { start: 0.65, end: 0 },
        lifespan:  { min: 1500, max: 3000 },
        frequency: 280,
        quantity:  1,
        gravityY:  -6,
      }).setDepth(5);
    }

    // Animated graphic layers (cleared and redrawn every frame)
    this.waterGraphics    = this.add.graphics().setDepth(2);
    this.ambientLights    = this.add.graphics().setDepth(1);
    this.fountainGraphics = this.add.graphics().setDepth(12);

    // Player
    const pd = this.createCharacter(WORLD_W / 2, WORLD_H / 2, C.teal);
    this.myPlayer   = pd.container;
    this.myLeftLeg  = pd.leftLeg;
    this.myRightLeg = pd.rightLeg;
    this.myLeftArm  = pd.leftArm;
    this.myRightArm = pd.rightArm;
    this.myPlayer.setDepth(10);
    this.physics.add.existing(this.myPlayer);
    const physBody = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    physBody.setSize(28, 14);
    physBody.setOffset(-14, -7);
    this.cameras.main.startFollow(this.myPlayer, true, 0.09, 0.09);

    this.add.text(0, 0, "You", {
      fontFamily: "'Exo 2', sans-serif",
      fontSize: "12px", fontStyle: "bold",
      color: "#00e5cc", stroke: "#000000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setName("myLabel").setDepth(11);

    // Proximity
    this.proximityRing = this.add.graphics().setVisible(false).setDepth(5);
    this.talkHint = this.add.text(0, 0, "[ T ]  Talk", {
      fontFamily: "'Exo 2', sans-serif",
      fontSize: "12px", color: "#00e5cc", stroke: "#000000", strokeThickness: 2,
      backgroundColor: "#00000088", padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setVisible(false).setDepth(12);

    // Input
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up:    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.talkKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.T);

    this.setupSocketListeners();
    socket.emit(EVENTS.JOIN_ROOM, this.roomId);

    // Click-to-move
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.tweenPlayerTo(p.worldX, p.worldY));
  }

  update(time: number, delta: number) {
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);

    const up    = this.cursors.up.isDown    || this.wasd.up.isDown;
    const down  = this.cursors.down.isDown  || this.wasd.down.isDown;
    const left  = this.cursors.left.isDown  || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;
    if (left)       body.setVelocityX(-PLAYER_SPEED);
    else if (right) body.setVelocityX(PLAYER_SPEED);
    if (up)         body.setVelocityY(-PLAYER_SPEED);
    else if (down)  body.setVelocityY(PLAYER_SPEED);
    if ((left || right) && (up || down)) body.velocity.normalize().scale(PLAYER_SPEED);

    // Walk animation (delta-based for consistent speed across all frame rates)
    const moving = body.velocity.length() > 0;
    if (moving) {
      this.myWalkCycle += delta * 0.01; // 10 radians per second
      this.drawLegs(this.myLeftLeg, this.myRightLeg, this.myLeftArm, this.myRightArm, this.myWalkCycle, C.teal);
    } else if (this.myWalkCycle !== 0) {
      this.myWalkCycle = 0;
      this.drawLegs(this.myLeftLeg, this.myRightLeg, this.myLeftArm, this.myRightArm, 0, C.teal);
    }

    this.myPlayer.setDepth(Math.round(this.myPlayer.y));
    const myLabel = this.children.getByName("myLabel") as Phaser.GameObjects.Text | null;
    if (myLabel) {
      myLabel.setPosition(this.myPlayer.x, this.myPlayer.y - 62);
      myLabel.setDepth(Math.round(this.myPlayer.y) + 1);
    }

    if (time - this.lastEmitTime > EMIT_INTERVAL_MS) {
      socket.emit(EVENTS.PLAYER_MOVE, { x: Math.round(this.myPlayer.x), y: Math.round(this.myPlayer.y) } as MovePayload);
      this.lastEmitTime = time;
    }

    // Ambient animations
    this.fountainT += delta * 0.003;
    this.ambientT  += delta * 0.001;
    this.waterT    += delta * 0.002;
    this.drawFountainAnim();
    this.drawAmbientLights();
    this.drawWaterAnim();

    this.updateProximity();
    if (Phaser.Input.Keyboard.JustDown(this.talkKey) && this.currentNearbyId) {
      this.onTalkClicked(this.currentNearbyId);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  WORLD DRAW — STATIC
  // ══════════════════════════════════════════════════════════════

  private drawBackground() {
    const g = this.add.graphics().setDepth(0);
    // Deep navy-to-black gradient sky
    g.fillGradientStyle(0x1a2e4a, 0x0d1a2e, 0x04080f, 0x04080f);
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    // Dense starfield (300 stars)
    for (let i = 0; i < 300; i++) {
      const sx  = (i * 1237 + 53)  % WORLD_W;
      const sy  = (i * 431  + 71)  % WORLD_H;
      const bri = 0.15 + (i % 6) * 0.10;
      g.fillStyle(0xffffff, bri);
      const sr  = i % 12 === 0 ? 2.2 : i % 4 === 0 ? 1.4 : 0.8;
      g.fillCircle(sx, sy, sr);
    }
    // Soft galaxy smear
    g.fillStyle(0x162848, 0.18); g.fillEllipse(WORLD_W * 0.30, WORLD_H * 0.20, 800, 260);
    g.fillStyle(0x101e36, 0.12); g.fillEllipse(WORLD_W * 0.70, WORLD_H * 0.15, 900, 220);
  }

  /** Draw the floating island slab — earth/rock sides visible below the tile grid. */
  private drawIslandBase() {
    const SLAB_H = 90;
    const g = this.add.graphics().setDepth(0);
    // Grid corners in screen space (hC=15, hR=12)
    const TL = this.isoPos(-15, -12); // (1080, 360)
    const TR = this.isoPos( 15, -12); // (2280, 960)
    const BR = this.isoPos( 15,  12); // (1320, 1440)
    const BL = this.isoPos(-15,  12); // (120, 840)
    // Left (SW) face
    g.fillStyle(C.earthFront);
    g.beginPath();
    g.moveTo(TL.x, TL.y); g.lineTo(BL.x, BL.y);
    g.lineTo(BL.x, BL.y + SLAB_H); g.lineTo(TL.x, TL.y + SLAB_H);
    g.closePath(); g.fillPath();
    // Bottom (S) face
    g.fillStyle(C.earthFront);
    g.beginPath();
    g.moveTo(BL.x, BL.y); g.lineTo(BR.x, BR.y);
    g.lineTo(BR.x, BR.y + SLAB_H); g.lineTo(BL.x, BL.y + SLAB_H);
    g.closePath(); g.fillPath();
    // Right (SE) face
    g.fillStyle(C.earthRight);
    g.beginPath();
    g.moveTo(BR.x, BR.y); g.lineTo(TR.x, TR.y);
    g.lineTo(TR.x, TR.y + SLAB_H); g.lineTo(BR.x, BR.y + SLAB_H);
    g.closePath(); g.fillPath();
    // Bottom cap fill
    g.fillStyle(C.earthBottom);
    g.beginPath();
    g.moveTo(TL.x, TL.y + SLAB_H); g.lineTo(TR.x, TR.y + SLAB_H);
    g.lineTo(BR.x, BR.y + SLAB_H); g.lineTo(BL.x, BL.y + SLAB_H);
    g.closePath(); g.fillPath();
    // Edge highlight at top rim
    g.lineStyle(2, 0xffffff, 0.12);
    g.beginPath();
    g.moveTo(TL.x, TL.y); g.lineTo(BL.x, BL.y); g.lineTo(BR.x, BR.y); g.lineTo(TR.x, TR.y);
    g.strokePath();
  }

  /** Convert grid (col, row) → screen (x, y). Origin = world center. */
  private isoPos(col: number, row: number): { x: number; y: number } {
    return {
      x: WORLD_W / 2 + (col - row) * T,
      y: WORLD_H / 2 + (col + row) * (T / 2),
    };
  }

  private drawFloorTiles() {
    const g = this.add.graphics().setDepth(1);
    const COLS = 30, ROWS = 24;
    const hC = COLS / 2, hR = ROWS / 2;
    // Lake is centered at grid (6, -7), Manhattan radius 5 = water, 5-8 = beach
    const LCX = 6, LCY = -7;
    for (let row = -hR; row < hR; row++) {
      for (let col = -hC; col < hC; col++) {
        const c   = this.isoPos(col, row);
        const alt = (col + row) % 2 === 0;
        const dist     = Math.abs(col) + Math.abs(row);
        const lakeDist = Math.abs(col - LCX) + Math.abs(row - LCY);
        const isWater  = lakeDist <= 4;
        const isBeach  = !isWater && lakeDist <= 7;
        const isCity   = !isWater && !isBeach && dist <= 5;
        let tileColor: number;
        if      (isWater)  tileColor = alt ? C.water    : C.waterAlt;
        else if (isBeach)  tileColor = alt ? C.beach    : C.beachAlt;
        else if (isCity)   tileColor = alt ? C.road     : C.roadAlt;
        else               tileColor = alt ? C.grass    : C.grassAlt;
        g.fillStyle(tileColor);
        g.beginPath();
        g.moveTo(c.x,     c.y - T / 2);
        g.lineTo(c.x + T, c.y);
        g.lineTo(c.x,     c.y + T / 2);
        g.lineTo(c.x - T, c.y);
        g.closePath(); g.fillPath();
        // Tile edge lines
        g.lineStyle(1, 0x000000, isWater ? 0.06 : 0.04);
        g.strokePath();
      }
    }
    // Water edge highlight
    g.lineStyle(2.5, C.waterShine, 0.55);
    for (let row = -hR; row < hR; row++) {
      for (let col = -hC; col < hC; col++) {
        const lakeDist = Math.abs(col - LCX) + Math.abs(row - LCY);
        if (lakeDist !== 5) continue; // shore edge ring
        const c = this.isoPos(col, row);
        this.strokeIsoDiamond(g, c.x, c.y, T, T / 2);
      }
    }
  }

  private drawRoads() {
    const g = this.add.graphics().setDepth(2);
    // City block crossroads pattern around center
    for (let i = -6; i <= 6; i++) {
      // E–W spine
      const h = this.isoPos(i, 0);
      g.fillStyle(C.road, 0.65); this.fillIsoDiamond(g, h.x, h.y, T * 1.05, T * 0.53);
      g.lineStyle(1.5, 0x000000, 0.08); this.strokeIsoDiamond(g, h.x, h.y, T * 1.05, T * 0.53);
      // N–S spine
      const v = this.isoPos(0, i);
      g.fillStyle(C.road, 0.65); this.fillIsoDiamond(g, v.x, v.y, T * 1.05, T * 0.53);
      g.lineStyle(1.5, 0x000000, 0.08); this.strokeIsoDiamond(g, v.x, v.y, T * 1.05, T * 0.53);
    }
    // Secondary roads
    for (const [ci, ri] of [[-4,0],[0,-3],[4,0],[0,3]] as [number,number][]) {
      for (let t2 = -5; t2 <= 5; t2++) {
        const axis = ri !== 0 ? this.isoPos(t2, ri) : this.isoPos(ci, t2);
        g.fillStyle(C.roadAlt, 0.5); this.fillIsoDiamond(g, axis.x, axis.y, T, T * 0.5);
      }
    }
    // Road centre line dashes
    g.lineStyle(1, 0xffffff, 0.12);
    for (let i = -5; i <= 5; i += 2) {
      const dh = this.isoPos(i, 0);
      g.beginPath();
      g.moveTo(dh.x - T * 0.35, dh.y); g.lineTo(dh.x + T * 0.35, dh.y);
      g.strokePath();
    }
  }

  private drawZoneLabels() {
    // Minimal floating labels — no neon, just clean Nunito text
    const zones: [number, number, string, string][] = [
      [ 0,  0, "Town Square",  "#ffffff"],
      [-9, -9, "Park",         "#a8f0a0"],
      [ 6, -7, "Lake",         "#a0d8f0"],
      [-6,  8, "Garden",       "#d4c8f0"],
      [ 8,  7, "Harbor",       "#a0c8ff"],
      [-4, -8, "Residential",  "#f0e8a0"],
    ];
    for (const [col, row, name, hex] of zones) {
      const p = this.isoPos(col, row);
      const t = this.add.text(p.x, p.y - 28, name, {
        fontFamily: "'Nunito', sans-serif",
        fontSize:   "13px",
        fontStyle:  "bold",
        color:      hex,
        stroke:     "#000000",
        strokeThickness: 3,
      }).setOrigin(0.5).setDepth(4).setAlpha(0.82);
      this.tweens.add({ targets: t, alpha: { from: 0.5, to: 0.92 }, duration: 3000 + Math.random() * 1000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  private drawBuildings() {
    const g = this.add.graphics().setDepth(6);

    // ── Dense city district — white/grey low-poly blocks in city zone (dist ≤ 5)
    const cityBuildings: [number,number,number,number,number][] = [
      // [col, row, halfW_mult, halfH_mult, height]
      // Town hall (centre)
      [ 0,  0, 1.1, 0.55, 68],
      // Surrounding city blocks
      [ 2, -2, 0.85, 0.43, 52],  [-2,  2, 0.85, 0.43, 52],
      [ 2,  2, 0.90, 0.45, 44],  [-2, -2, 0.75, 0.38, 38],
      [ 3,  0, 0.70, 0.35, 34],  [ 0,  3, 0.65, 0.33, 30],
      [-3,  0, 0.80, 0.40, 36],  [ 0, -3, 0.72, 0.36, 32],
      [ 3, -3, 0.60, 0.30, 26],  [-3,  3, 0.60, 0.30, 26],
      [ 4,  1, 0.55, 0.28, 22],  [ 1,  4, 0.55, 0.28, 20],
      [-4, -1, 0.55, 0.28, 22],  [-1, -4, 0.55, 0.28, 20],
      [ 4, -1, 0.50, 0.25, 18],  [-1,  4, 0.50, 0.25, 18],
      [-4,  1, 0.50, 0.25, 18],  [ 1, -4, 0.50, 0.25, 18],
      // Tall towers
      [ 1, -1, 0.65, 0.33, 78],  [-1,  1, 0.65, 0.33, 72],
    ];
    for (const [c, r, wm, hm, ht] of cityBuildings) {
      const p = this.isoPos(c, r);
      this.drawIsoBuilding(g, p.x, p.y, T * wm, T * hm, ht, C.wallA, C.roofA);
    }

    // ── Lighthouse near lake shore ──
    { const p = this.isoPos(4, -6); this.drawIsoBuilding(g, p.x, p.y, T*0.38, T*0.19, 70, C.wallA, C.gold); }

    // ── Scattered small cottages in grass zone ──
    for (const [c, r] of [
      [-6,-5],[-5,-8],[-8,-4],[-7,-6],
      [6, 5],[7, 8],[8, 4],[5, 7],
      [-6, 5],[-8, 6],[-5, 8],
      [6,-5],[8,-4],[5,-7],
    ] as [number,number][]) {
      const p = this.isoPos(c, r);
      this.drawIsoBuilding(g, p.x, p.y, T*0.50, T*0.25, 20, C.wallB, C.roofB);
    }

    // ── Decorative stone pillars at city entrance ──
    for (const [c, r] of [[5,-5],[-5,5],[5,5],[-5,-5]] as [number,number][]) {
      const p = this.isoPos(c, r);
      this.drawIsoPillar(g, p.x, p.y);
    }
  }

  private drawIsoBuilding(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, height: number, sideCol: number, roofCol: number) {
    const shade = this.darken(sideCol, 28);
    // Left face (lit)
    g.fillStyle(sideCol);
    g.beginPath(); g.moveTo(x-w,y); g.lineTo(x,y-h); g.lineTo(x,y-h-height); g.lineTo(x-w,y-height); g.closePath(); g.fillPath();
    g.lineStyle(1, 0x000000, 0.18); g.strokePath();
    // Right face (shadowed)
    g.fillStyle(shade);
    g.beginPath(); g.moveTo(x+w,y); g.lineTo(x,y-h); g.lineTo(x,y-h-height); g.lineTo(x+w,y-height); g.closePath(); g.fillPath();
    g.lineStyle(1, 0x000000, 0.18); g.strokePath();
    // Roof (flat diamond)
    g.fillStyle(roofCol);
    g.beginPath(); g.moveTo(x-w,y-height); g.lineTo(x,y-h-height); g.lineTo(x+w,y-height); g.lineTo(x,y+h-height); g.closePath(); g.fillPath();
    g.lineStyle(1.5, 0xffffff, 0.22); g.strokePath();
    // Windows: small blue squares
    if (height > 22) {
      g.fillStyle(C.windows, 0.75);
      const wRow = Math.floor(height / 20);
      for (let wi = 0; wi < wRow; wi++) {
        const wy = y - height * 0.2 - wi * 18;
        g.fillRect(x - w * 0.68, wy, w * 0.25, 8);
        g.fillRect(x - w * 0.28, wy, w * 0.25, 8);
      }
    }
  }

  private drawIsoPillar(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    // Grey stone pillar — no neon
    const shaft = 0xb0b8c0, shadow = 0x828a90, cap = 0xd0d8e0;
    g.fillStyle(shadow); g.fillRect(x,   y-38, 5, 34);
    g.fillStyle(shaft);  g.fillRect(x-5, y-38, 5, 34);
    g.fillStyle(cap);    g.fillEllipse(x, y-38, 14, 6);
    g.fillStyle(0xf0f4f8, 0.9); g.fillCircle(x-2, y-40, 2.5);
  }

  private drawTrees() {
    const g = this.add.graphics().setDepth(7);
    // Deterministic pseudo-random using a simple hash so trees are stable
    const rng = (c: number, r: number) => {
      const s = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const treeColors: number[] = [C.treeA, C.treeB, C.treeC];
    for (let row = -12; row < 12; row++) {
      for (let col = -15; col < 15; col++) {
        const dist     = Math.abs(col) + Math.abs(row);
        const lakeDist = Math.abs(col - 6) + Math.abs(row + 7);
        // No trees on water, beach, city roads
        if (lakeDist <= 7) continue;
        if (dist <= 6)     continue;
        // Density: high at edges, lower towards mid-island
        const edgeDist = Math.min(
          14 - Math.abs(col), 11 - Math.abs(row)
        );
        const density = edgeDist < 3 ? 0.68 : edgeDist < 6 ? 0.35 : 0.15;
        if (rng(col, row) > density) continue;
        const p = this.isoPos(col, row);
        const ci = Math.floor(rng(col + 1, row) * treeColors.length);
        this.drawIsoTree(g, p.x, p.y, treeColors[ci]);
      }
    }
  }

  private drawIsoTree(g: Phaser.GameObjects.Graphics, x: number, y: number, canopy: number) {
    const trunk = C.treeTrunk;
    const dark  = this.darken(canopy, 25);
    const light = this.lighten(canopy, 18);
    // Trunk — two-faced rectangular pillars
    g.fillStyle(this.darken(trunk, 25)); g.fillRect(x,   y-20, 4, 18);
    g.fillStyle(trunk);                  g.fillRect(x-4, y-20, 4, 18);
    // 4-tiered conical foliage (wide base → narrow tip)
    g.fillStyle(dark,  0.92); this.fillIsoDiamond(g, x, y-22, 30, 15);  // tier 1 (base)
    g.fillStyle(canopy,0.95); this.fillIsoDiamond(g, x, y-33, 23, 11);  // tier 2
    g.fillStyle(canopy,0.95); this.fillIsoDiamond(g, x, y-42, 16,  8);  // tier 3
    g.fillStyle(light, 0.90); this.fillIsoDiamond(g, x, y-50,  9,  4);  // tier 4 (tip)
    // Specular highlight on tip
    g.fillStyle(0xffffff, 0.28); g.fillCircle(x - 2, y-52, 2);
  }

  // ══════════════════════════════════════════════════════════════
  //  WORLD DRAW — ANIMATED
  // ══════════════════════════════════════════════════════════════

  private drawFountainAnim() {
    // Lake shimmer at isoPos(6, -7)
    const g = this.fountainGraphics;
    g.clear();
    const { x: lx, y: ly } = this.isoPos(6, -7);
    const t = this.fountainT;

    // Gentle sun sparkle dots scattered over lake
    for (let i = 0; i < 8; i++) {
      const phase = (t * 1.2 + i * 0.78) % (Math.PI * 2);
      const ox = Math.cos(i * 1.3) * 60;
      const oy = Math.sin(i * 0.9) * 28;
      const alpha = 0.12 + Math.abs(Math.sin(phase)) * 0.38;
      g.fillStyle(C.waterShine, alpha);
      g.fillCircle(lx + ox, ly + oy, 3 + Math.sin(phase + i) * 1.5);
    }
    // Slow expanding ripple ring
    const rp = (t * 0.28) % 1;
    g.lineStyle(2, C.waterShine, (1 - rp) * 0.36);
    g.strokeEllipse(lx, ly, T * 9 * rp, T * 4.5 * rp);
    // Secondary ripple offset
    const rp2 = (t * 0.28 + 0.5) % 1;
    g.lineStyle(1.5, C.waterShine, (1 - rp2) * 0.22);
    g.strokeEllipse(lx, ly, T * 9 * rp2, T * 4.5 * rp2);
  }

  private drawAmbientLights() {
    // Subtle day-light atmosphere — no neon halos
    const g = this.ambientLights;
    g.clear();
    const t = this.ambientT;

    // Very faint warm sun glow over lake area (top-right)
    const { x: lx, y: ly } = this.isoPos(6, -7);
    const pulse = (Math.sin(t * 0.5) + 1) / 2;
    g.fillStyle(C.waterShine, 0.04 + pulse * 0.03);
    g.fillEllipse(lx, ly, 420, 210);

    // Soft daytime sky reflection across island top
    g.fillStyle(0xaaddff, 0.025 + pulse * 0.015);
    g.fillEllipse(WORLD_W / 2, WORLD_H * 0.42, WORLD_W * 0.6, WORLD_H * 0.18);
  }

  private drawWaterAnim() {
    // Lake wave ripples at isoPos(6,-7)
    const g = this.waterGraphics;
    g.clear();
    const t = this.waterT;
    const { x: lx, y: ly } = this.isoPos(6, -7);

    // Iso-aligned wave lines across lake surface
    for (let i = 0; i < 5; i++) {
      const wave = Math.sin(t * 2.4 + i * 0.7) * 3;
      const alpha = 0.14 + Math.sin(t * 1.8 + i) * 0.06;
      g.lineStyle(1.5, C.waterShine, alpha);
      const offX = -60 + i * 28, offY = -24 + i * 11;
      g.beginPath();
      g.moveTo(lx + offX - 40, ly + offY + wave);
      g.lineTo(lx + offX + 40, ly + offY + wave + 3);
      g.strokePath();
    }
    // Small glint on centre
    const gs = (Math.sin(t * 3.2) + 1) / 2;
    g.fillStyle(0xffffff, 0.08 + gs * 0.12);
    g.fillCircle(lx + 8, ly - 6, 5 + gs * 4);
  }

  // ══════════════════════════════════════════════════════════════
  //  CHARACTER RENDERING
  // ══════════════════════════════════════════════════════════════

  private createCharacter(x: number, y: number, color: number): {
    container: Phaser.GameObjects.Container;
    leftLeg:   Phaser.GameObjects.Graphics;
    rightLeg:  Phaser.GameObjects.Graphics;
    leftArm:   Phaser.GameObjects.Graphics;
    rightArm:  Phaser.GameObjects.Graphics;
  } {
    const container = this.add.container(x, y);
    const g = this.add.graphics();

    const SKIN   = 0xf5c09a;
    const SKIN_D = 0xd4906a;
    const HAIR   = 0x2a1808;
    const SHIRT_T = this.lighten(color, 18);
    const SHIRT_D = this.darken(color, 38);

    // Separate animated layers
    const leftLeg  = this.add.graphics();
    const rightLeg = this.add.graphics();
    const leftArm  = this.add.graphics();
    const rightArm = this.add.graphics();

    // === Ground shadow ===
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 5, 34, 12);

    // === Torso (shirt) — isometric two-face ===
    // Left face (lit)
    g.fillStyle(color);
    g.beginPath();
    g.moveTo(-14, -20); g.lineTo(-3, -26); g.lineTo(-3, -48); g.lineTo(-14, -42);
    g.closePath(); g.fillPath();
    g.lineStyle(1, 0x000000, 0.12); g.strokePath();
    // Right face (shadow)
    g.fillStyle(SHIRT_D);
    g.beginPath();
    g.moveTo(4, -20); g.lineTo(-3, -26); g.lineTo(-3, -48); g.lineTo(4, -42);
    g.closePath(); g.fillPath();
    g.lineStyle(1, 0x000000, 0.12); g.strokePath();
    // Shoulder top (small diamond)
    g.fillStyle(SHIRT_T);
    g.beginPath();
    g.moveTo(-14, -42); g.lineTo(-3, -48); g.lineTo(4, -42); g.lineTo(-3, -36);
    g.closePath(); g.fillPath();
    g.lineStyle(1, 0xffffff, 0.10); g.strokePath();

    // === Belt ===
    g.fillStyle(0x1a1a2a, 0.88);
    g.beginPath();
    g.moveTo(-14, -22); g.lineTo(-3, -28); g.lineTo(4, -22); g.lineTo(-3, -16);
    g.closePath(); g.fillPath();
    g.fillStyle(C.gold, 0.88); g.fillRect(-5, -26, 5, 3);

    // === Neck ===
    g.fillStyle(SKIN);   g.fillRect(-5, -54, 5, 8);
    g.fillStyle(SKIN_D); g.fillRect( 0, -54, 4, 8);

    // === Head — round human face ===
    // Hair back (silhouette behind face)
    g.fillStyle(HAIR);
    g.fillEllipse(-3, -65, 32, 24);
    // Face — left lit half
    g.fillStyle(SKIN);
    g.fillEllipse(-7, -66, 25, 22);
    // Face — right shadow half
    g.fillStyle(SKIN_D);
    g.fillEllipse( 3, -65, 18, 20);
    // Centre blend
    g.fillStyle(SKIN);
    g.fillEllipse(-5, -66, 14, 19);
    // Jaw shadow
    g.fillStyle(SKIN_D, 0.45);
    g.fillEllipse(-3, -57, 18, 8);

    // === Hair crown + sides ===
    g.fillStyle(HAIR);
    g.fillEllipse(-3, -76, 28, 14);   // top crown
    g.fillEllipse(-13, -69, 12, 9);   // left side hang
    g.fillEllipse(  5, -68,  9, 7);   // right side
    g.fillStyle(this.lighten(HAIR, 14), 0.35);
    g.fillEllipse(-8, -78, 14, 6);    // crown sheen

    // === Eyes ===
    // Left eye
    g.fillStyle(0xffffff, 0.95); g.fillEllipse(-11, -66, 7, 5);
    g.fillStyle(0x2a1a0a);       g.fillCircle(-11, -66, 2.2);
    g.fillStyle(0x000000);       g.fillCircle(-11, -66, 1.4);
    g.fillStyle(0xffffff, 0.85); g.fillCircle(-10, -67, 0.8);
    // Right eye
    g.fillStyle(0xffffff, 0.9);  g.fillEllipse(-3, -67, 7, 5);
    g.fillStyle(0x2a1a0a);       g.fillCircle(-3, -67, 2.2);
    g.fillStyle(0x000000);       g.fillCircle(-3, -67, 1.4);
    g.fillStyle(0xffffff, 0.85); g.fillCircle(-2, -68, 0.8);
    // Eyebrows
    g.lineStyle(2, HAIR, 0.90);
    g.beginPath(); g.moveTo(-14, -71); g.lineTo(-8, -72); g.strokePath();
    g.beginPath(); g.moveTo(-6,  -72); g.lineTo( 0, -71); g.strokePath();

    // === Nose ===
    g.fillStyle(SKIN_D, 0.55);
    g.fillEllipse(-7, -62, 5, 4);
    g.fillStyle(SKIN, 0.45); g.fillCircle(-8, -63, 1.2);

    // === Mouth ===
    g.lineStyle(1.6, 0x9a4040, 0.82);
    g.beginPath();
    g.moveTo(-11, -58); g.lineTo(-8, -56); g.lineTo(-5, -55); g.lineTo(-3, -56); g.lineTo(-1, -58);
    g.strokePath();
    g.lineStyle(1, 0x7a3030, 0.35);
    g.beginPath();
    g.moveTo(-11, -58); g.lineTo(-9, -60); g.lineTo(-6, -61); g.lineTo(-3, -60); g.lineTo(-1, -58);
    g.strokePath();

    // === Ear (left side visible) ===
    g.fillStyle(SKIN);    g.fillEllipse(-16, -65, 6, 10);
    g.fillStyle(SKIN_D, 0.45); g.fillEllipse(-16, -65, 4, 7);

    // Layer order: legs, body, arms, head (head drawn into g which comes after arms)
    container.add([leftLeg, rightLeg, g, leftArm, rightArm]);
    container.setDepth(Math.round(y));
    
    // Draw initial rest pose AFTER adding to container
    this.drawLegs(leftLeg, rightLeg, leftArm, rightArm, 0, color);
    
    return { container, leftLeg, rightLeg, leftArm, rightArm };
  }

  drawLegs(
    lL: Phaser.GameObjects.Graphics, rL: Phaser.GameObjects.Graphics,
    lA: Phaser.GameObjects.Graphics, rA: Phaser.GameObjects.Graphics,
    cycle: number, color: number
  ) {
    const SKIN   = 0xf5c09a;
    const SKIN_D = 0xd4906a;
    const PANTS  = 0x2c3e58;
    const PAN_D  = 0x1a2840;
    const SHOE   = 0x221814;
    const SHOE_D = 0x110a08;
    const SHRT_D = this.darken(color, 38);
    const SHRT_D2= this.darken(color, 55);

    const lSw  =  Math.sin(cycle) * 7;             // left ankle swing
    const rSw  =  Math.sin(cycle + Math.PI) * 7;   // right ankle swing
    const lASw =  Math.sin(cycle + Math.PI) * 4.5; // left arm (opposite)
    const rASw =  Math.sin(cycle) * 4.5;            // right arm

    // ===== LEFT LEG =====
    lL.clear();
    // Thigh — left face
    lL.fillStyle(PANTS);
    lL.beginPath();
    lL.moveTo(-14,-8); lL.lineTo(-6,-12); lL.lineTo(-6,-26); lL.lineTo(-14,-22);
    lL.closePath(); lL.fillPath();
    // Thigh — right face
    lL.fillStyle(PAN_D);
    lL.beginPath();
    lL.moveTo(-6,-12); lL.lineTo(0,-8); lL.lineTo(0,-22); lL.lineTo(-6,-26);
    lL.closePath(); lL.fillPath();
    // Shin — left face (swings)
    lL.fillStyle(PANTS);
    lL.beginPath();
    lL.moveTo(-13,-2+lSw); lL.lineTo(-6,-6+lSw); lL.lineTo(-6,-10); lL.lineTo(-13,-8);
    lL.closePath(); lL.fillPath();
    // Shin — right face
    lL.fillStyle(PAN_D);
    lL.beginPath();
    lL.moveTo(-6,-6+lSw); lL.lineTo(0,-2+lSw); lL.lineTo(0,-8); lL.lineTo(-6,-10);
    lL.closePath(); lL.fillPath();
    // Shoe
    lL.fillStyle(SHOE);   lL.fillEllipse(-7,  1+lSw, 16, 7);
    lL.fillStyle(SHOE_D); lL.fillEllipse(-4, -1+lSw, 11, 4);

    // ===== RIGHT LEG =====
    rL.clear();
    // Thigh — left face
    rL.fillStyle(PANTS);
    rL.beginPath();
    rL.moveTo(-1,-8); rL.lineTo(6,-12); rL.lineTo(6,-26); rL.lineTo(-1,-22);
    rL.closePath(); rL.fillPath();
    // Thigh — right face
    rL.fillStyle(PAN_D);
    rL.beginPath();
    rL.moveTo(6,-12); rL.lineTo(12,-8); rL.lineTo(12,-22); rL.lineTo(6,-26);
    rL.closePath(); rL.fillPath();
    // Shin — left face
    rL.fillStyle(PANTS);
    rL.beginPath();
    rL.moveTo(-1,-2+rSw); rL.lineTo(6,-6+rSw); rL.lineTo(6,-10); rL.lineTo(-1,-8);
    rL.closePath(); rL.fillPath();
    // Shin — right face
    rL.fillStyle(PAN_D);
    rL.beginPath();
    rL.moveTo(6,-6+rSw); rL.lineTo(12,-2+rSw); rL.lineTo(12,-8); rL.lineTo(6,-10);
    rL.closePath(); rL.fillPath();
    // Shoe
    rL.fillStyle(SHOE);   rL.fillEllipse(5,  1+rSw, 16, 7);
    rL.fillStyle(SHOE_D); rL.fillEllipse(8, -1+rSw, 11, 4);

    // ===== LEFT ARM =====
    lA.clear();
    lA.fillStyle(color);   lA.fillRect(-21, -50 + lASw * 0.5, 6, 20); // shirt sleeve
    lA.fillStyle(SKIN);    lA.fillRect(-21, -32 + lASw,       6, 12); // forearm
    lA.fillStyle(SKIN);    lA.fillEllipse(-18, -21 + lASw, 9, 9);     // hand
    lA.fillStyle(SKIN_D, 0.4); lA.fillEllipse(-17, -21 + lASw, 6, 6);

    // ===== RIGHT ARM =====
    rA.clear();
    rA.fillStyle(SHRT_D);  rA.fillRect(11, -50 + rASw * 0.5, 6, 20); // shirt sleeve shadow
    rA.fillStyle(SKIN_D);  rA.fillRect(11, -32 + rASw,       6, 12); // forearm
    rA.fillStyle(SKIN_D);  rA.fillEllipse(14, -21 + rASw, 9, 9);     // hand
    rA.fillStyle(SHRT_D2, 0.25); rA.fillEllipse(14, -21 + rASw, 6, 6);
  }

  // ══════════════════════════════════════════════════════════════
  //  PROXIMITY
  // ══════════════════════════════════════════════════════════════

  private updateProximity() {
    let closestId: string | null = null;
    let closestDist = PROXIMITY_RADIUS + 1;
    for (const [id, s] of this.otherPlayers) {
      const dx = this.myPlayer.x - s.body.x;
      const dy = this.myPlayer.y - s.body.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < closestDist) { closestDist = d; closestId = id; }
    }
    if (closestId !== this.currentNearbyId) this.setNearby(closestId);

    if (closestId) {
      const sp = this.otherPlayers.get(closestId)!;
      const tx = sp.body.x, ty = sp.body.y;
      this.proximityRing.clear();
      this.proximityRing.lineStyle(2.5, C.teal, 0.85);
      this.strokeIsoDiamond(this.proximityRing, tx, ty, 56, 28);
      const pulse = (Math.sin(this.time.now * 0.003) + 1) / 2;
      this.proximityRing.lineStyle(1.5, C.teal, 0.18 + pulse * 0.28);
      this.strokeIsoDiamond(this.proximityRing, tx, ty, 47, 23);
      this.talkHint.setPosition(tx, ty - 70);
    }
  }

  private setNearby(id: string | null) {
    this.currentNearbyId = id;
    this.proximityRing.setVisible(id !== null);
    this.talkHint.setVisible(id !== null);
    this.onNearbyChange(id);
  }

  // ══════════════════════════════════════════════════════════════
  //  SOCKET / LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  private setupSocketListeners() {
    socket.off(EVENTS.SELF_PLAYER,   this.onSelfPlayer);
    socket.off(EVENTS.ROOM_STATE,    this.onRoomState);
    socket.off(EVENTS.PLAYER_JOINED, this.onPlayerJoined);
    socket.off(EVENTS.PLAYER_MOVED,  this.onPlayerMoved);
    socket.off(EVENTS.PLAYER_LEFT,   this.onPlayerLeft);
    socket.on(EVENTS.SELF_PLAYER,    this.onSelfPlayer);
    socket.on(EVENTS.ROOM_STATE,     this.onRoomState);
    socket.on(EVENTS.PLAYER_JOINED,  this.onPlayerJoined);
    socket.on(EVENTS.PLAYER_MOVED,   this.onPlayerMoved);
    socket.on(EVENTS.PLAYER_LEFT,    this.onPlayerLeft);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      socket.off(EVENTS.SELF_PLAYER,   this.onSelfPlayer);
      socket.off(EVENTS.ROOM_STATE,    this.onRoomState);
      socket.off(EVENTS.PLAYER_JOINED, this.onPlayerJoined);
      socket.off(EVENTS.PLAYER_MOVED,  this.onPlayerMoved);
      socket.off(EVENTS.PLAYER_LEFT,   this.onPlayerLeft);
      this.onNearbyChange(null);
    });
  }

  private spawnOtherPlayer(player: Player) {
    if (this.otherPlayers.has(player.id)) return;
    const colorInt = parseInt(player.color.replace("#", ""), 16);
    const cd = this.createCharacter(player.x, player.y, colorInt);
    cd.container.setDepth(Math.round(player.y));
    const nameLabel = this.add.text(player.x, player.y - 62, player.id.slice(0, 6), {
      fontFamily: "'Exo 2', sans-serif",
      fontSize: "11px", color: "#ffffff", stroke: "#000000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(Math.round(player.y) + 1);
    this.otherPlayers.set(player.id, {
      body: cd.container, nameLabel,
      leftLeg: cd.leftLeg, rightLeg: cd.rightLeg,
      leftArm: cd.leftArm, rightArm: cd.rightArm,
      walkCycle: 0, color: colorInt,
    });
  }

  private destroyOtherPlayer(playerId: string) {
    const s = this.otherPlayers.get(playerId);
    if (!s) return;
    s.body.destroy();
    s.nameLabel.destroy();
    this.otherPlayers.delete(playerId);
  }

  private tweenPlayerTo(x: number, y: number) {
    const body = this.myPlayer.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);
    this.tweens.add({ targets: this.myPlayer, x, y, duration: 380, ease: "Power2" });
  }

  // ══════════════════════════════════════════════════════════════
  //  UTILITY PRIMITIVES
  // ══════════════════════════════════════════════════════════════

  private fillIsoDiamond(g: Phaser.GameObjects.Graphics, cx: number, cy: number, hw: number, hh: number) {
    g.beginPath();
    g.moveTo(cx,      cy - hh);
    g.lineTo(cx + hw, cy);
    g.lineTo(cx,      cy + hh);
    g.lineTo(cx - hw, cy);
    g.closePath();
    g.fillPath();
  }

  private strokeIsoDiamond(g: Phaser.GameObjects.Graphics, cx: number, cy: number, hw: number, hh: number) {
    g.strokePoints([
      { x: cx,      y: cy - hh },
      { x: cx + hw, y: cy      },
      { x: cx,      y: cy + hh },
      { x: cx - hw, y: cy      },
      { x: cx,      y: cy - hh },
    ], true);
  }

  private darken(color: number, amt: number): number {
    return Phaser.Display.Color.GetColor(
      Math.max(0, ((color >> 16) & 0xFF) - amt),
      Math.max(0, ((color >>  8) & 0xFF) - amt),
      Math.max(0, ( color        & 0xFF) - amt),
    );
  }

  private lighten(color: number, amt: number): number {
    return Phaser.Display.Color.GetColor(
      Math.min(255, ((color >> 16) & 0xFF) + amt),
      Math.min(255, ((color >>  8) & 0xFF) + amt),
      Math.min(255, ( color        & 0xFF) + amt),
    );
  }
}
