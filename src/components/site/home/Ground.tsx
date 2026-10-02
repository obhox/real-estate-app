"use client";

import { useRef, useState } from "react";
import { Play } from "lucide-react";
import { GROUND_VIDEO } from "@/lib/site";

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono text-[12px] tracking-[0.14em] uppercase text-[#5B5346] mt-2 truncate">{children}</div>
  );
}

function VideoTile({ src, poster, label, caption }: { src: string; poster: string; label: string; caption: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  function play() {
    const v = videoRef.current;
    if (!v) return;
    v.play().then(() => setPlaying(true)).catch(() => {});
  }

  return (
    <figure>
      <div className="relative rounded-[14px] overflow-hidden aspect-[3/2] bg-[#12291F]">
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover blur-md scale-110 opacity-60 pointer-events-none"
        />
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          preload="none"
          playsInline
          controls={playing}
          className="absolute inset-0 w-full h-full object-contain"
          aria-label={label}
        />
        {!playing && (
          <button
            onClick={play}
            className="absolute inset-0 grid place-items-center group"
            aria-label={`Play ${label}`}
          >
            <span className="h-12 w-12 rounded-full bg-white/95 text-[#12291F] grid place-items-center group-hover:scale-105 transition-transform">
              <Play size={20} strokeWidth={2} aria-hidden="true" className="ml-0.5" />
            </span>
          </button>
        )}
      </div>
      <Caption>{caption}</Caption>
    </figure>
  );
}

export default function Ground() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  function play() {
    const v = videoRef.current;
    if (!v) return;
    v.play().then(() => setPlaying(true)).catch(() => {});
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-5">
      <figure className="col-span-2 md:col-span-2 md:row-span-2">
        <div className="relative rounded-[14px] overflow-hidden aspect-[16/10] md:aspect-auto md:h-full md:min-h-[420px] bg-[#12291F]">
          <video
            ref={videoRef}
            src={GROUND_VIDEO.src}
            poster="/ground-video-poster.jpg"
            preload="none"
            playsInline
            controls={playing}
            className="absolute inset-0 w-full h-full object-cover"
            aria-label="Site walk video"
          />
          {!playing && (
            <button
              onClick={play}
              className="absolute inset-0 grid place-items-center group"
              aria-label="Play site walk video"
            >
              <span className="h-16 w-16 rounded-full bg-white/95 text-[#12291F] grid place-items-center group-hover:scale-105 transition-transform">
                <Play size={24} strokeWidth={2} aria-hidden="true" className="ml-1" />
              </span>
            </button>
          )}
        </div>
      </figure>
      <VideoTile
        src="/aurum-residence-walk.mp4"
        poster="/aurum-residence-poster.jpg"
        label="Aurum Residence site walk video"
        caption="Aurum Residence · Site walk · Sep 2026"
      />
      <VideoTile
        src="/starlight-kyami-walk.mp4"
        poster="/starlight-kyami-poster.jpg"
        label="Starlight Kyami site walk video"
        caption="Starlight · Kyami · Sep 2026"
      />
    </div>
  );
}
