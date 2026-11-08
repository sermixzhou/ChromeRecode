const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
let binary;

// ffmpeg can decode avc3 files that Apple's playback framework rejects.
// Exercise the native decoder as well on the platform where this regressed.
module.exports=function assertMacOSPlayback(filename,{sampled=false}={}){
  if(process.platform!=='darwin')return;
  if(!binary){
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'keye-media-check-'));
    process.once('exit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
    const source=path.join(scratch,'check.m');binary=path.join(scratch,'check');
    fs.writeFileSync(source,`
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2 || argc > 3) return 2;
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(argv[1])] options:nil];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (!asset.playable || !tracks.count) { NSLog(@"Unplayable video: %@", asset.URL); return 1; }
    double duration = CMTimeGetSeconds(asset.duration);
    double videoEnd = CMTimeGetSeconds(CMTimeRangeGetEnd(tracks.firstObject.timeRange));
    if (duration - videoEnd > 0.5) { NSLog(@"Video ends at %.3f, asset ends at %.3f", videoEnd, duration); return 1; }
    double decodedEnd = 0;
    NSArray<NSNumber *> *starts = argc == 3 ? @[@0, @(duration/2), @(MAX(0,duration-0.5))] : @[@0];
    for (NSNumber *start in starts) {
    NSError *error = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    if (argc == 3) reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(start.doubleValue, 60000), CMTimeMakeWithSeconds(0.5, 60000));
    AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:tracks.firstObject outputSettings:@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA)}];
    if (!reader || ![reader canAddOutput:output]) { NSLog(@"Reader setup failed: %@", error); return 1; }
    [reader addOutput:output];
    if (![reader startReading]) { NSLog(@"Decode failed: %@", reader.error); return 1; }
    NSUInteger frames = 0;
    CMSampleBufferRef sample;
    while ((sample = [output copyNextSampleBuffer])) {
      frames++;
      decodedEnd = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
      CFRelease(sample);
    }
    if (!frames || reader.status != AVAssetReaderStatusCompleted) { NSLog(@"Incomplete decode: %@", reader.error); return 1; }
    }
    if (duration - decodedEnd > 0.5) { NSLog(@"Last decoded frame %.3f, expected %.3f", decodedEnd, duration); return 1; }
    return 0;
  }
}
`);
    execFileSync('clang',['-w','-fobjc-arc','-framework','Foundation','-framework','AVFoundation','-framework','CoreVideo','-framework','CoreMedia',source,'-o',binary]);
  }
  execFileSync(binary,[filename,...sampled?['sampled']:[]],{timeout:30000});
};
