import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://keye-recorder.yangzhou123.chatgpt.site"),
  title: "刻页 · 记录此刻，留住每一页",
  description: "刻页，让网页里的声音与画面留下来。轻松录制当前页签，本地预览与裁剪，导出 MP4、WebM、MP3 或 WAV。基础功能免费，无需注册。",
  openGraph: {
    title: "刻页 · 记录此刻，留住每一页",
    description: "录下网页里的声音与画面，剪掉多余，留下刚刚好的那一段。",
    locale: "zh_CN",
    type: "website",
    images: [{url:"/social-card.png", width:1200, height:630}],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
