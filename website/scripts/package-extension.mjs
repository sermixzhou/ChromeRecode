import {readFileSync,writeFileSync,mkdirSync,cpSync,mkdtempSync,rmSync,statSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import os from "node:os";

const site=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const project=path.resolve(site,"..");
const extension=path.join(project,"extension");
const manifest=JSON.parse(readFileSync(path.join(extension,"manifest.json"),"utf8"));
const filename=`keye-v${manifest.version}.zip`;
const downloads=path.join(site,"public/downloads");
mkdirSync(downloads,{recursive:true});
const staging=mkdtempSync(path.join(os.tmpdir(),"keye-release-"));
try {
  cpSync(extension,path.join(staging,"extension"),{recursive:true,filter:source=>!path.basename(source).startsWith(".")});
  cpSync(path.join(project,"安装说明.md"),path.join(staging,"安装说明.md"));
  const target=path.join(downloads,filename);
  // Recreate rather than update: ZIP updates retain removed files from older releases.
  rmSync(target,{force:true});
  execFileSync("zip",["-qr",target,"extension","安装说明.md"],{cwd:staging});
  cpSync(path.join(project,"安装说明.md"),path.join(downloads,"keye-installation.md"));
  const size=statSync(target).size;
  const sha256=createHash("sha256").update(readFileSync(target)).digest("hex");
  writeFileSync(path.join(site,"lib/release.json"),JSON.stringify({version:manifest.version,filename,guideFilename:"keye-installation.md",sizeBytes:size,sizeLabel:`${Math.round(size/1024)} KB`,sha256},null,2)+"\n");
  writeFileSync(path.join(downloads,`${filename}.sha256`),`${sha256}  ${filename}\n`);
  console.log(`Packaged 刻页 ${manifest.version} (${Math.round(size/1024)} KB); SHA-256 ${sha256}`);
} finally {rmSync(staging,{recursive:true,force:true});}
