"use client";

import { useState } from "react";
import { Pan115QrConnect } from "./pan115-qr-connect";
import { QuarkQrConnect } from "./quark-qr-connect";
import { QuarkCookieConnect } from "./quark-cookie-connect";

type Brand = "pan115" | "quark";

/** 品牌图库瓦片的静态元数据:图标走 /brands/<key>.svg(workspace-switcher 同款资产),
 *  authNote 把认证方式前置到选择时刻(选之前就知道要扫码还是粘贴)。 */
const BRAND_TILES: Array<{ key: Brand; label: string; authNote: string }> = [
  { key: "pan115", label: "115网盘", authNote: "扫码登录" },
  { key: "quark", label: "夸克网盘", authNote: "扫码 / 粘 cookie" },
];

/** Settings「添加网盘」:集成图库式品牌选择(图标 + 名称 + 认证方式瓦片),选中后
 *  瓦片下方展开该品牌的连接区。115 扫码登录;夸克扫码,折叠 cookie 粘贴回退
 *  (QR 的凭证兑换是易碎跳)。Each bound drive becomes its own isolated workspace
 *  (tree model). defaultBrand:首盘用户传 "pan115" 直接引导扫码;已有盘时传 null,
 *  连接区收起,点瓦片才展开(添加是低频动作,别让 115 连接区常驻占位)。再点选中
 *  瓦片可收起。 */
export function AddDriveBrandTabs({ defaultBrand = "pan115" }: { defaultBrand?: Brand | null }) {
  const [brand, setBrand] = useState<Brand | null>(defaultBrand);

  return (
    <div>
      <div className="brand-gallery" role="group" aria-label="选择网盘品牌">
        {BRAND_TILES.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`brand-tile${brand === tile.key ? " is-selected" : ""}`}
            onClick={() => setBrand(brand === tile.key ? null : tile.key)}
            aria-pressed={brand === tile.key}
          >
            {/* 已注册品牌必有 svg(加品牌 touch-point 清单项);alt 空,名称由下方文字承担。
                本地小 svg 无需 next/image 优化(workspace-switcher 同款惯例)。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-tile-icon" src={`/brands/${tile.key}.svg`} alt="" width={32} height={32} />
            <span className="brand-tile-label">{tile.label}</span>
            <span className="brand-tile-note">{tile.authNote}</span>
          </button>
        ))}
      </div>
      {brand === "pan115" ? (
        <div className="brand-connect-area">
          <Pan115QrConnect />
        </div>
      ) : brand === "quark" ? (
        <div className="brand-connect-area">
          <QuarkQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <QuarkCookieConnect />
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
