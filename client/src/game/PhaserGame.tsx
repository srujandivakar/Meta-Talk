import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { WorldScene } from "./WorldScene";

interface PhaserGameProps {
  roomId: string;
  onNearbyChange: (playerId: string | null) => void;
  onTalkClicked: (targetId: string) => void;
}

export function PhaserGame({ roomId, onNearbyChange, onTalkClicked }: PhaserGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (gameRef.current) gameRef.current.destroy(true);

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      width: window.innerWidth,
      height: window.innerHeight,
      parent: containerRef.current,
      backgroundColor: "#0a0a0a",
      physics: {
        default: "arcade",
        arcade: { gravity: { x: 0, y: 0 }, debug: false },
      },
      scene: [],
      banner: false,
    };

    gameRef.current = new Phaser.Game(config);

    // Pass roomId + React callbacks into the scene via Phaser's data system.
    // WorldScene.init() receives this object before create() runs.
    gameRef.current.scene.add("WorldScene", WorldScene, true, {
      roomId,
      onNearbyChange,
      onTalkClicked,
    });

    const handleResize = () => {
      gameRef.current?.scale.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{ width: "100vw", height: "100vh", position: "fixed", top: 0, left: 0 }}
    />
  );
}
