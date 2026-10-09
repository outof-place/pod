// Native Ghostty terminal surfaces overlaid on an Electron BrowserWindow (macOS).
//
// Ghostty renders with Metal and encodes input; Orca's terminal daemon keeps owning the PTY.
// Output reaches the surface through write_buffer_replay so Ghostty never answers terminal
// queries (Orca's existing emulator already does), and keystrokes come back as encoded bytes.
//
// Input handling in OrcaGhosttySurfaceView is adapted from Ghostty's SurfaceView_AppKit.swift
// (MIT, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors).

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <node_api.h>

#include <atomic>
#include <cstring>
#include <string>

#include "ghostty.h"

namespace {

struct SurfaceEvent;

struct SurfaceModel {
  int32_t id = 0;
  ghostty_surface_t surface = nullptr;
  napi_threadsafe_function events = nullptr;
  bool closed = false;
};

// No C++ globals with dynamic constructors: Xcode's linker rejects them in this bundle.
ghostty_app_t g_app = nullptr;
ghostty_config_t g_config = nullptr;
std::atomic<bool> g_tick_pending{false};
std::atomic<int32_t> g_next_id{1};
NSMutableDictionary<NSNumber*, id>* g_views = nil;

enum class SurfaceEventKind { Input, Resize, Focus, Key, Title, Pwd, OpenUrl, Bell, MouseShape, ContextMenu };

struct SurfaceEvent {
  SurfaceEventKind kind;
  std::string text;
  uint32_t a = 0, b = 0, c = 0, d = 0;
};

void Emit(SurfaceModel* model, SurfaceEvent* event) {
  if (model == nullptr || model->events == nullptr || model->closed) {
    delete event;
    return;
  }
  if (napi_call_threadsafe_function(model->events, event, napi_tsfn_nonblocking) != napi_ok) {
    delete event;
  }
}

ghostty_input_mods_e GhosttyMods(NSEventModifierFlags flags) {
  uint32_t mods = GHOSTTY_MODS_NONE;
  if (flags & NSEventModifierFlagShift) mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;
  const NSUInteger raw = flags;
  if (raw & NX_DEVICERSHIFTKEYMASK) mods |= GHOSTTY_MODS_SHIFT_RIGHT;
  if (raw & NX_DEVICERCTLKEYMASK) mods |= GHOSTTY_MODS_CTRL_RIGHT;
  if (raw & NX_DEVICERALTKEYMASK) mods |= GHOSTTY_MODS_ALT_RIGHT;
  if (raw & NX_DEVICERCMDKEYMASK) mods |= GHOSTTY_MODS_SUPER_RIGHT;
  return static_cast<ghostty_input_mods_e>(mods);
}

NSEventModifierFlags EventFlags(ghostty_input_mods_e mods) {
  NSEventModifierFlags flags = 0;
  if (mods & GHOSTTY_MODS_SHIFT) flags |= NSEventModifierFlagShift;
  if (mods & GHOSTTY_MODS_CTRL) flags |= NSEventModifierFlagControl;
  if (mods & GHOSTTY_MODS_ALT) flags |= NSEventModifierFlagOption;
  if (mods & GHOSTTY_MODS_SUPER) flags |= NSEventModifierFlagCommand;
  if (mods & GHOSTTY_MODS_CAPS) flags |= NSEventModifierFlagCapsLock;
  return flags;
}

ghostty_input_key_s KeyEvent(NSEvent* event, ghostty_input_action_e action, NSEventModifierFlags translationFlags) {
  ghostty_input_key_s key = {};
  key.action = action;
  key.keycode = event.keyCode;
  key.text = nullptr;
  key.composing = false;
  // Control and command never contribute to text translation on macOS.
  key.mods = GhosttyMods(event.modifierFlags);
  key.consumed_mods =
      GhosttyMods(translationFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.unshifted_codepoint = 0;
  if (event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp) {
    NSString* chars = [event charactersByApplyingModifiers:0];
    if (chars.length > 0) {
      key.unshifted_codepoint = static_cast<uint32_t>([chars characterAtIndex:0]);
    }
  }
  return key;
}

// Control characters are encoded by Ghostty itself; PUA function-key glyphs carry no text.
NSString* GhosttyCharacters(NSEvent* event) {
  NSString* chars = event.characters;
  if (chars == nil) return nil;
  if (chars.length == 1) {
    const unichar scalar = [chars characterAtIndex:0];
    if (scalar < 0x20) {
      return [event charactersByApplyingModifiers:(event.modifierFlags & ~NSEventModifierFlagControl)];
    }
    if (scalar >= 0xF700 && scalar <= 0xF8FF) return nil;
  }
  return chars;
}

bool IsSingleControl(NSString* text) {
  if (text.length != 1) return false;
  return [text characterAtIndex:0] < 0x20;
}

NSString* KeyboardLayoutId() {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  if (source == nullptr) return nil;
  NSString* layout = (__bridge NSString*)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
  NSString* copy = [layout copy];
  CFRelease(source);
  return copy;
}

void ScheduleTick() {
  if (g_tick_pending.exchange(true)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    g_tick_pending.store(false);
    if (g_app != nullptr) ghostty_app_tick(g_app);
  });
}

}  // namespace

// Flipped so frames match DOM coordinates; hit-testing falls through to web contents
// everywhere except over a visible surface.
@interface OrcaGhosttyHostView : NSView
@end

@implementation OrcaGhosttyHostView
- (BOOL)isFlipped {
  return YES;
}
- (NSView*)hitTest:(NSPoint)point {
  NSView* hit = [super hitTest:point];
  return hit == self ? nil : hit;
}
@end

@interface OrcaGhosttySurfaceView : NSView <NSTextInputClient>
@property(nonatomic, assign) SurfaceModel* model;
@end

@implementation OrcaGhosttySurfaceView {
  NSMutableAttributedString* _markedText;
  NSMutableArray<NSString*>* _keyTextAccumulator;
  NSTrackingArea* _trackingArea;
  BOOL _focused;
}

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    _markedText = [[NSMutableAttributedString alloc] init];
  }
  return self;
}

- (ghostty_surface_t)surface {
  return self.model ? self.model->surface : nullptr;
}

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent*)event {
  return YES;
}

- (BOOL)becomeFirstResponder {
  BOOL result = [super becomeFirstResponder];
  if (result) [self focusDidChange:YES];
  return result;
}

- (BOOL)resignFirstResponder {
  BOOL result = [super resignFirstResponder];
  if (result) [self focusDidChange:NO];
  return result;
}

- (void)focusDidChange:(BOOL)focused {
  if (_focused == focused) return;
  _focused = focused;
  if (self.surface) ghostty_surface_set_focus(self.surface, focused);
  auto* event = new SurfaceEvent{SurfaceEventKind::Focus};
  event->a = focused ? 1 : 0;
  Emit(self.model, event);
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingInVisibleRect |
                   NSTrackingActiveAlways
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)syncSurfaceSize {
  if (!self.surface) return;
  NSSize backing = [self convertSizeToBacking:self.bounds.size];
  if (backing.width < 1 || backing.height < 1) return;
  ghostty_surface_set_size(self.surface, static_cast<uint32_t>(backing.width),
                           static_cast<uint32_t>(backing.height));
}

- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [self syncSurfaceSize];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  if (self.window) {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.layer.contentsScale = self.window.backingScaleFactor;
    [CATransaction commit];
  }
  if (!self.surface || self.bounds.size.width <= 0 || self.bounds.size.height <= 0) return;
  NSRect fb = [self convertRectToBacking:self.bounds];
  ghostty_surface_set_content_scale(self.surface, fb.size.width / self.bounds.size.width,
                                    fb.size.height / self.bounds.size.height);
  [self syncSurfaceSize];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  NSScreen* screen = self.window.screen;
  if (self.surface && screen) {
    NSNumber* displayId = screen.deviceDescription[@"NSScreenNumber"];
    ghostty_surface_set_display_id(self.surface, displayId.unsignedIntValue);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self viewDidChangeBackingProperties];
  });
}

#pragma mark Mouse

- (void)sendMousePos:(NSEvent*)event {
  if (!self.surface) return;
  NSPoint pos = [self convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(self.surface, pos.x, self.frame.size.height - pos.y,
                            GhosttyMods(event.modifierFlags));
}

- (void)mouseDown:(NSEvent*)event {
  if (self.window.firstResponder != self) [self.window makeFirstResponder:self];
  if (!self.surface) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseUp:(NSEvent*)event {
  if (!self.surface) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
  ghostty_surface_mouse_pressure(self.surface, 0, 0);
}

- (void)rightMouseDown:(NSEvent*)event {
  if (self.surface && ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT,
                                                   GhosttyMods(event.modifierFlags))) {
    return;
  }
  // Not claimed by mouse reporting: Orca's pane context menu lives in the web contents.
  NSView* content = self.window.contentView;
  NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
  auto* forwarded = new SurfaceEvent{SurfaceEventKind::ContextMenu};
  forwarded->a = static_cast<uint32_t>(MAX(0, point.x));
  forwarded->b = static_cast<uint32_t>(MAX(0, content.bounds.size.height - point.y));
  Emit(self.model, forwarded);
}

- (void)rightMouseUp:(NSEvent*)event {
  if (self.surface && ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT,
                                                   GhosttyMods(event.modifierFlags))) {
    return;
  }
  [super rightMouseUp:event];
}

- (void)otherMouseDown:(NSEvent*)event {
  if (!self.surface || event.buttonNumber != 2) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_MIDDLE,
                               GhosttyMods(event.modifierFlags));
}

- (void)otherMouseUp:(NSEvent*)event {
  if (!self.surface || event.buttonNumber != 2) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_MIDDLE,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseEntered:(NSEvent*)event {
  [super mouseEntered:event];
  [self sendMousePos:event];
}

- (void)mouseExited:(NSEvent*)event {
  if (!self.surface || NSEvent.pressedMouseButtons != 0) return;
  // Negative coordinates tell Ghostty the cursor left the viewport.
  ghostty_surface_mouse_pos(self.surface, -1, -1, GhosttyMods(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)mouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)rightMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)otherMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)scrollWheel:(NSEvent*)event {
  if (!self.surface) return;
  double x = event.scrollingDeltaX;
  double y = event.scrollingDeltaY;
  const bool precision = event.hasPreciseScrollingDeltas;
  if (precision) {
    x *= 2;
    y *= 2;
  }
  int momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  const NSEventPhase phase = event.momentumPhase;
  if (phase & NSEventPhaseBegan) momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;
  else if (phase & NSEventPhaseStationary) momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY;
  else if (phase & NSEventPhaseChanged) momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;
  else if (phase & NSEventPhaseEnded) momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;
  else if (phase & NSEventPhaseCancelled) momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
  else if (phase & NSEventPhaseMayBegin) momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;
  const ghostty_input_scroll_mods_t mods = (precision ? 1 : 0) | (momentum << 1);
  ghostty_surface_mouse_scroll(self.surface, x, y, mods);
}

- (void)pressureChangeWithEvent:(NSEvent*)event {
  if (!self.surface) return;
  ghostty_surface_mouse_pressure(self.surface, static_cast<uint32_t>(event.stage), event.pressure);
}

#pragma mark Keyboard

// Command chords belong to Orca (menus, tab and pane shortcuts), not the terminal.
- (BOOL)forwardsToHost:(NSEvent*)event {
  return (event.modifierFlags & NSEventModifierFlagCommand) != 0 && _markedText.length == 0;
}

- (void)emitForwardedKey:(NSEvent*)event {
  auto* forwarded = new SurfaceEvent{SurfaceEventKind::Key};
  // Unshifted so the host sees the physical key plus a shift modifier, like a DOM keydown.
  NSString* chars = [event charactersByApplyingModifiers:0] ?: @"";
  forwarded->text = chars.UTF8String ?: "";
  forwarded->a = event.keyCode;
  forwarded->b = static_cast<uint32_t>(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask);
  forwarded->c = event.isARepeat ? 1 : 0;
  Emit(self.model, forwarded);
}

- (BOOL)performKeyEquivalent:(NSEvent*)event {
  // Returning NO lets the main menu (Electron accelerators) try the chord; if nothing
  // claims it AppKit delivers it to keyDown, which forwards it to the renderer.
  return NO;
}

- (BOOL)keyAction:(ghostty_input_action_e)action
            event:(NSEvent*)event
 translationEvent:(NSEvent*)translationEvent
             text:(NSString*)text
        composing:(BOOL)composing {
  if (!self.surface) return NO;
  ghostty_input_key_s key =
      KeyEvent(event, action, translationEvent ? translationEvent.modifierFlags : event.modifierFlags);
  key.composing = composing;
  if (text.length > 0 && [text characterAtIndex:0] >= 0x20) {
    key.text = text.UTF8String;
  }
  return ghostty_surface_key(self.surface, key);
}

- (BOOL)committedTextAction:(ghostty_input_action_e)action text:(NSString*)text {
  if (!self.surface) return NO;
  ghostty_input_key_s key = {};
  key.action = action;
  key.mods = GHOSTTY_MODS_NONE;
  key.consumed_mods = GHOSTTY_MODS_NONE;
  key.text = text.UTF8String;
  return ghostty_surface_key(self.surface, key);
}

- (BOOL)shouldReplayCommittedPreeditKey:(NSEvent*)event {
  switch (event.keyCode) {
    case kVK_DownArrow:
    case kVK_RightArrow:
    case kVK_UpArrow:
      return YES;
    case kVK_LeftArrow:
      // Korean IMEs already leave the caret in place after committing.
      return (event.modifierFlags & (NSEventModifierFlagShift | NSEventModifierFlagControl |
                                     NSEventModifierFlagOption | NSEventModifierFlagCommand)) != 0;
    default:
      return NO;
  }
}

- (void)syncPreedit:(BOOL)clearIfNeeded {
  if (!self.surface) return;
  if (_markedText.length > 0) {
    const char* utf8 = _markedText.string.UTF8String;
    ghostty_surface_preedit(self.surface, utf8, strlen(utf8));
  } else if (clearIfNeeded) {
    ghostty_surface_preedit(self.surface, nullptr, 0);
  }
}

- (void)keyDown:(NSEvent*)event {
  if (!self.surface) {
    [self interpretKeyEvents:@[ event ]];
    return;
  }
  if ([self forwardsToHost:event]) {
    [self emitForwardedKey:event];
    return;
  }

  // Option-as-alt and friends change which modifiers translate text.
  NSEventModifierFlags ghosttyTranslation =
      EventFlags(ghostty_surface_key_translation_mods(self.surface, GhosttyMods(event.modifierFlags)));
  NSEventModifierFlags translationFlags = event.modifierFlags;
  for (NSEventModifierFlags flag : {NSEventModifierFlagShift, NSEventModifierFlagControl,
                                    NSEventModifierFlagOption, NSEventModifierFlagCommand}) {
    if (ghosttyTranslation & flag) translationFlags |= flag;
    else translationFlags &= ~flag;
  }
  // Reusing the original event when nothing changed keeps Korean input working.
  NSEvent* translationEvent = event;
  if (translationFlags != event.modifierFlags) {
    translationEvent = [NSEvent keyEventWithType:event.type
                                        location:event.locationInWindow
                                   modifierFlags:translationFlags
                                       timestamp:event.timestamp
                                    windowNumber:event.windowNumber
                                         context:nil
                                      characters:[event charactersByApplyingModifiers:translationFlags] ?: @""
                     charactersIgnoringModifiers:event.charactersIgnoringModifiers ?: @""
                                       isARepeat:event.isARepeat
                                         keyCode:event.keyCode] ?: event;
  }

  const ghostty_input_action_e action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  _keyTextAccumulator = [NSMutableArray array];
  const BOOL markedTextBefore = _markedText.length > 0;
  NSString* layoutBefore = markedTextBefore ? nil : KeyboardLayoutId();

  [self interpretKeyEvents:@[ translationEvent ]];

  NSArray<NSString*>* accumulated = _keyTextAccumulator;
  _keyTextAccumulator = nil;

  // A layout switch shortcut was consumed by the input method.
  if (!markedTextBefore && layoutBefore && ![layoutBefore isEqualToString:KeyboardLayoutId() ?: @""]) {
    return;
  }

  [self syncPreedit:markedTextBefore];
  const BOOL composing = _markedText.length > 0 || markedTextBefore;

  if (markedTextBefore && accumulated.count > 0) {
    for (NSString* text in accumulated) {
      if (composing && IsSingleControl(text)) continue;
      [self committedTextAction:action text:text];
    }
    if ([self shouldReplayCommittedPreeditKey:translationEvent]) {
      [self keyAction:action event:event translationEvent:translationEvent text:nil composing:NO];
    }
    return;
  }

  if (accumulated.count > 0) {
    for (NSString* text in accumulated) {
      if (composing && IsSingleControl(text)) continue;
      [self keyAction:action event:event translationEvent:translationEvent text:text composing:NO];
    }
    return;
  }

  if (composing && IsSingleControl(event.characters)) return;
  [self keyAction:action
                 event:event
      translationEvent:translationEvent
                  text:GhosttyCharacters(translationEvent)
             composing:composing];
}

- (void)keyUp:(NSEvent*)event {
  if ([self forwardsToHost:event]) return;
  [self keyAction:GHOSTTY_ACTION_RELEASE event:event translationEvent:nil text:nil composing:NO];
}

- (void)flagsChanged:(NSEvent*)event {
  uint32_t mod = 0;
  switch (event.keyCode) {
    case 0x39: mod = GHOSTTY_MODS_CAPS; break;
    case 0x38: case 0x3C: mod = GHOSTTY_MODS_SHIFT; break;
    case 0x3B: case 0x3E: mod = GHOSTTY_MODS_CTRL; break;
    case 0x3A: case 0x3D: mod = GHOSTTY_MODS_ALT; break;
    case 0x37: case 0x36: mod = GHOSTTY_MODS_SUPER; break;
    default: return;
  }
  if (_markedText.length > 0) return;
  ghostty_input_action_e action = GHOSTTY_ACTION_RELEASE;
  if (GhosttyMods(event.modifierFlags) & mod) {
    const NSUInteger raw = event.modifierFlags;
    bool sidePressed = true;
    switch (event.keyCode) {
      case 0x3C: sidePressed = raw & NX_DEVICERSHIFTKEYMASK; break;
      case 0x3E: sidePressed = raw & NX_DEVICERCTLKEYMASK; break;
      case 0x3D: sidePressed = raw & NX_DEVICERALTKEYMASK; break;
      case 0x36: sidePressed = raw & NX_DEVICERCMDKEYMASK; break;
      default: break;
    }
    if (sidePressed) action = GHOSTTY_ACTION_PRESS;
  }
  [self keyAction:action event:event translationEvent:nil text:nil composing:NO];
}

- (void)doCommandBySelector:(SEL)selector {
  // Swallow AppKit editing commands (no beep); Ghostty already encoded the key.
}

#pragma mark Clipboard and menu actions

- (IBAction)copy:(id)sender {
  if (self.surface) ghostty_surface_binding_action(self.surface, "copy_to_clipboard", strlen("copy_to_clipboard"));
}

- (IBAction)paste:(id)sender {
  if (self.surface) {
    ghostty_surface_binding_action(self.surface, "paste_from_clipboard", strlen("paste_from_clipboard"));
  }
}

- (IBAction)selectAll:(id)sender {
  if (self.surface) ghostty_surface_binding_action(self.surface, "select_all", strlen("select_all"));
}

- (BOOL)validateMenuItem:(NSMenuItem*)item {
  if (item.action == @selector(copy:)) return self.surface && ghostty_surface_has_selection(self.surface);
  return YES;
}

#pragma mark NSTextInputClient

- (BOOL)hasMarkedText {
  return _markedText.length > 0;
}

- (NSRange)markedRange {
  return _markedText.length > 0 ? NSMakeRange(0, _markedText.length) : NSMakeRange(NSNotFound, 0);
}

- (NSRange)selectedRange {
  if (!self.surface) return NSMakeRange(NSNotFound, 0);
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(self.surface, &text)) return NSMakeRange(NSNotFound, 0);
  NSRange range = NSMakeRange(text.offset_start, text.offset_len);
  ghostty_surface_free_text(self.surface, &text);
  return range;
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
  if ([string isKindOfClass:[NSAttributedString class]]) {
    _markedText = [[NSMutableAttributedString alloc] initWithAttributedString:string];
  } else if ([string isKindOfClass:[NSString class]]) {
    _markedText = [[NSMutableAttributedString alloc] initWithString:string];
  }
  // Outside keyDown (e.g. a layout change mid-composition) preedit must update now.
  if (_keyTextAccumulator == nil) [self syncPreedit:YES];
}

- (void)unmarkText {
  if (_markedText.length > 0) {
    [_markedText.mutableString setString:@""];
    [self syncPreedit:YES];
  }
}

- (NSArray<NSAttributedStringKey>*)validAttributesForMarkedText {
  return @[];
}

- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  return nil;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
  return 0;
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  if (!self.surface) return NSMakeRect(self.frame.origin.x, self.frame.origin.y, 0, 0);
  double x = 0, y = 0, width = 0, height = 0;
  ghostty_surface_ime_point(self.surface, &x, &y, &width, &height);
  if (range.length == 0 && width > 0) width = 0;
  NSRect viewRect = NSMakeRect(x, self.frame.size.height - y, width, height);
  NSRect windowRect = [self convertRect:viewRect toView:nil];
  return self.window ? [self.window convertRectToScreen:windowRect] : windowRect;
}

- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
  if (NSApp.currentEvent == nil) return;
  NSString* chars = [string isKindOfClass:[NSAttributedString class]] ? [string string] : string;
  if (![chars isKindOfClass:[NSString class]]) return;
  [self unmarkText];
  if (_keyTextAccumulator != nil) {
    [_keyTextAccumulator addObject:chars];
    return;
  }
  // Committed IME/dictation text is typed input, never a paste.
  if (chars.length > 0) [self committedTextAction:GHOSTTY_ACTION_PRESS text:chars];
}

@end

namespace {

#pragma mark Runtime callbacks

OrcaGhosttySurfaceView* ViewForSurfaceUserdata(void* userdata) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr) return nil;
  return g_views[@(model->id)];
}

SurfaceModel* ModelForTarget(ghostty_target_s target) {
  if (target.tag != GHOSTTY_TARGET_SURFACE || target.target.surface == nullptr) return nullptr;
  return static_cast<SurfaceModel*>(ghostty_surface_userdata(target.target.surface));
}

void OnWakeup(void*) {
  ScheduleTick();
}

bool OnAction(ghostty_app_t, ghostty_target_s target, ghostty_action_s action) {
  SurfaceModel* model = ModelForTarget(target);
  switch (action.tag) {
    case GHOSTTY_ACTION_SET_TITLE: {
      if (!model || !action.action.set_title.title) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::Title};
      event->text = action.action.set_title.title;
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_PWD: {
      if (!model || !action.action.pwd.pwd) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::Pwd};
      event->text = action.action.pwd.pwd;
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_OPEN_URL: {
      if (!model || !action.action.open_url.url) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::OpenUrl};
      event->text.assign(action.action.open_url.url, action.action.open_url.len);
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_RING_BELL: {
      if (!model) return false;
      Emit(model, new SurfaceEvent{SurfaceEventKind::Bell});
      return true;
    }
    case GHOSTTY_ACTION_MOUSE_SHAPE: {
      NSCursor* cursor = NSCursor.arrowCursor;
      switch (action.action.mouse_shape) {
        case GHOSTTY_MOUSE_SHAPE_TEXT: cursor = NSCursor.IBeamCursor; break;
        case GHOSTTY_MOUSE_SHAPE_POINTER: cursor = NSCursor.pointingHandCursor; break;
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR: cursor = NSCursor.crosshairCursor; break;
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED: cursor = NSCursor.operationNotAllowedCursor; break;
        default: break;
      }
      [cursor set];
      return true;
    }
    default:
      return false;
  }
}

ghostty_clipboard_read_result_e OnReadClipboard(void* userdata, ghostty_clipboard_e location, void* state,
                                                const char* const* mimes, size_t mimes_len, bool list) {
  OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(userdata);
  if (view == nil || view.model->surface == nullptr || location != GHOSTTY_CLIPBOARD_STANDARD) {
    return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED;
  }
  NSString* string = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
  if (string == nil) return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE;
  const char* utf8 = string.UTF8String;
  ghostty_clipboard_content_s content = {"text/plain", utf8, strlen(utf8)};
  const char* available[] = {"text/plain"};
  ghostty_clipboard_complete_s complete = {};
  complete.contents = &content;
  complete.contents_len = 1;
  complete.available = list ? available : nullptr;
  complete.available_len = list ? 1 : 0;
  complete.confirmed = true;
  ghostty_surface_complete_clipboard_request(view.model->surface, &complete, state);
  return GHOSTTY_CLIPBOARD_READ_STARTED;
}

void OnConfirmReadClipboard(void* userdata, const ghostty_clipboard_confirm_s*, void* state,
                            ghostty_clipboard_request_e) {
  // OSC 52 reads are Orca's call; the shadow emulator already answers them.
  OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(userdata);
  if (view != nil && view.model->surface) ghostty_surface_deny_clipboard_request(view.model->surface, state);
}

void OnWriteClipboard(void*, ghostty_clipboard_e location, const ghostty_clipboard_content_s* contents,
                      size_t len, bool) {
  if (location != GHOSTTY_CLIPBOARD_STANDARD) return;
  for (size_t i = 0; i < len; i++) {
    if (contents[i].mime && strcmp(contents[i].mime, "text/plain") == 0 && contents[i].data) {
      NSString* text = [[NSString alloc] initWithBytes:contents[i].data
                                                length:contents[i].len
                                              encoding:NSUTF8StringEncoding];
      if (text == nil) return;
      [NSPasteboard.generalPasteboard clearContents];
      [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
      return;
    }
  }
}

void OnCloseSurface(void*, bool) {
  // The daemon owns the process; closing a pane goes through Orca.
}

void OnReceiveBuffer(void* userdata, const uint8_t* bytes, size_t len) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr || len == 0) return;
  auto* event = new SurfaceEvent{SurfaceEventKind::Input};
  event->text.assign(reinterpret_cast<const char*>(bytes), len);
  Emit(model, event);
}

void OnReceiveResize(void* userdata, uint16_t cols, uint16_t rows, uint32_t width, uint32_t height) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr) return;
  auto* event = new SurfaceEvent{SurfaceEventKind::Resize};
  event->a = cols;
  event->b = rows;
  event->c = width;
  event->d = height;
  Emit(model, event);
}

#pragma mark N-API helpers

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Bool(napi_env env, bool b) {
  napi_value value;
  napi_get_boolean(env, b, &value);
  return value;
}

napi_value Number(napi_env env, double n) {
  napi_value value;
  napi_create_double(env, n, &value);
  return value;
}

napi_value String(napi_env env, const std::string& s) {
  napi_value value;
  napi_create_string_utf8(env, s.data(), s.size(), &value);
  return value;
}

bool ThrowIf(napi_env env, bool failed, const char* message) {
  if (failed) napi_throw_error(env, nullptr, message);
  return failed;
}

double GetDouble(napi_env env, napi_value value) {
  double d = 0;
  napi_get_value_double(env, value, &d);
  return d;
}

int32_t GetInt(napi_env env, napi_value value) {
  int32_t i = 0;
  napi_get_value_int32(env, value, &i);
  return i;
}

bool GetBool(napi_env env, napi_value value) {
  bool b = false;
  napi_get_value_bool(env, value, &b);
  return b;
}

std::string GetString(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, value, s.data(), len + 1, &len);
  return s;
}

OrcaGhosttySurfaceView* ViewForId(int32_t id) {
  return g_views[@(id)];
}

void CallJs(napi_env env, napi_value callback, void*, void* data) {
  auto* event = static_cast<SurfaceEvent*>(data);
  if (env != nullptr && callback != nullptr) {
    napi_value argv[5];
    size_t argc = 1;
    switch (event->kind) {
      case SurfaceEventKind::Input: {
        argv[0] = String(env, "input");
        void* out = nullptr;
        napi_create_buffer_copy(env, event->text.size(), event->text.data(), &out, &argv[1]);
        argc = 2;
        break;
      }
      case SurfaceEventKind::Resize:
        argv[0] = String(env, "resize");
        argv[1] = Number(env, event->a);
        argv[2] = Number(env, event->b);
        argv[3] = Number(env, event->c);
        argv[4] = Number(env, event->d);
        argc = 5;
        break;
      case SurfaceEventKind::Focus:
        argv[0] = String(env, "focus");
        argv[1] = Bool(env, event->a != 0);
        argc = 2;
        break;
      case SurfaceEventKind::Key:
        argv[0] = String(env, "key");
        argv[1] = String(env, event->text);
        argv[2] = Number(env, event->a);
        argv[3] = Number(env, event->b);
        argv[4] = Bool(env, event->c != 0);
        argc = 5;
        break;
      case SurfaceEventKind::Title:
        argv[0] = String(env, "title");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::Pwd:
        argv[0] = String(env, "pwd");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::OpenUrl:
        argv[0] = String(env, "openUrl");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::Bell:
        argv[0] = String(env, "bell");
        break;
      case SurfaceEventKind::MouseShape:
        argv[0] = String(env, "mouseShape");
        break;
      case SurfaceEventKind::ContextMenu:
        argv[0] = String(env, "contextMenu");
        argv[1] = Number(env, event->a);
        argv[2] = Number(env, event->b);
        argc = 3;
        break;
    }
    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, argc, argv, nullptr);
  }
  delete event;
}

ghostty_config_t LoadConfig(const std::string& path) {
  ghostty_config_t config = ghostty_config_new();
  // The user's own Ghostty config is deliberately not loaded: Orca's settings drive the surface.
  if (!path.empty()) ghostty_config_load_file(config, path.c_str());
  ghostty_config_finalize(config);
  const uint32_t diagnostics = ghostty_config_diagnostics_count(config);
  for (uint32_t i = 0; i < diagnostics; i++) {
    ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(config, i);
    NSLog(@"[orca-ghostty] config: %s", diag.message);
  }
  return config;
}

OrcaGhosttyHostView* HostViewForWindowHandle(napi_env env, napi_value handle) {
  void* data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, handle, &data, &len) != napi_ok || len < sizeof(void*)) return nil;
  void* raw = nullptr;
  memcpy(&raw, data, sizeof(void*));
  NSView* contentView = (__bridge NSView*)raw;
  if (contentView == nil || contentView.window == nil) return nil;
  for (NSView* subview in contentView.subviews) {
    if ([subview isKindOfClass:[OrcaGhosttyHostView class]]) return (OrcaGhosttyHostView*)subview;
  }
  OrcaGhosttyHostView* host = [[OrcaGhosttyHostView alloc] initWithFrame:contentView.bounds];
  host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // Chromium keeps views it does not own above web contents; see native_widget_ns_window_bridge.mm.
  [contentView addSubview:host positioned:NSWindowAbove relativeTo:nil];
  return host;
}

#pragma mark Exports

// init(configPath?: string): boolean
napi_value Init(napi_env env, napi_callback_info info) {
  if (g_app != nullptr) return Bool(env, true);
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string path = argc > 0 ? GetString(env, argv[0]) : "";

  static char arg0[] = "orca";
  static char* args[] = {arg0, nullptr};
  if (ghostty_init(1, args) != 0) return Bool(env, false);

  g_config = LoadConfig(path);
  ghostty_runtime_config_s runtime = {};
  runtime.userdata = nullptr;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = OnWakeup;
  runtime.action_cb = OnAction;
  runtime.read_clipboard_cb = OnReadClipboard;
  runtime.confirm_read_clipboard_cb = OnConfirmReadClipboard;
  runtime.write_clipboard_cb = OnWriteClipboard;
  runtime.close_surface_cb = OnCloseSurface;
  g_app = ghostty_app_new(&runtime, g_config);
  if (g_app == nullptr) return Bool(env, false);
  g_views = [NSMutableDictionary dictionary];
  ghostty_app_set_focus(g_app, NSApp.isActive);
  return Bool(env, true);
}

// updateConfig(configPath: string): void
napi_value UpdateConfig(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (ThrowIf(env, g_app == nullptr || argc < 1, "ghostty not initialized")) return nullptr;
  ghostty_config_t next = LoadConfig(GetString(env, argv[0]));
  ghostty_app_update_config(g_app, next);
  for (OrcaGhosttySurfaceView* view in g_views.allValues) {
    if (view.model->surface) ghostty_surface_update_config(view.model->surface, next);
  }
  if (g_config) ghostty_config_free(g_config);
  g_config = next;
  return Undefined(env);
}

// createSurface(windowHandle: Buffer, x, y, width, height, onEvent): number
napi_value CreateSurface(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (ThrowIf(env, g_app == nullptr, "ghostty not initialized")) return nullptr;
  if (ThrowIf(env, argc < 6, "createSurface(handle, x, y, width, height, onEvent)")) return nullptr;
  OrcaGhosttyHostView* host = HostViewForWindowHandle(env, argv[0]);
  if (ThrowIf(env, host == nil, "invalid native window handle")) return nullptr;

  NSRect frame = NSMakeRect(GetDouble(env, argv[1]), GetDouble(env, argv[2]), GetDouble(env, argv[3]),
                            GetDouble(env, argv[4]));
  auto* model = new SurfaceModel();
  model->id = g_next_id.fetch_add(1);

  napi_value name = String(env, "orca-ghostty-surface");
  if (napi_create_threadsafe_function(env, argv[5], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs,
                                      &model->events) != napi_ok) {
    delete model;
    napi_throw_error(env, nullptr, "failed to create event channel");
    return nullptr;
  }
  // Event delivery must not keep Electron's main loop alive on quit.
  napi_unref_threadsafe_function(env, model->events);

  OrcaGhosttySurfaceView* view = [[OrcaGhosttySurfaceView alloc] initWithFrame:frame];
  view.model = model;
  [host addSubview:view];

  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void*)view;
  config.userdata = model;
  config.backend = GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED;
  config.receive_userdata = model;
  config.receive_buffer = OnReceiveBuffer;
  config.receive_resize = OnReceiveResize;
  config.scale_factor = host.window.backingScaleFactor;
  config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
  model->surface = ghostty_surface_new(g_app, &config);
  if (model->surface == nullptr) {
    [view removeFromSuperview];
    napi_release_threadsafe_function(model->events, napi_tsfn_abort);
    delete model;
    napi_throw_error(env, nullptr, "ghostty_surface_new failed");
    return nullptr;
  }
  g_views[@(model->id)] = view;
  [view viewDidChangeBackingProperties];
  ScheduleTick();
  return Number(env, model->id);
}

// writeOutput(id, data: Buffer): void
napi_value WriteOutput(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.model->surface == nullptr) return Undefined(env);
  void* data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[1], &data, &len) == napi_ok && len > 0) {
    ghostty_surface_write_buffer_replay(view.model->surface, static_cast<const uint8_t*>(data), len);
  }
  return Undefined(env);
}

// setFrames(frames: Array<[id, x, y, width, height, visible]>): void
napi_value SetFrames(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t count = 0;
  if (argc < 1 || napi_get_array_length(env, argv[0], &count) != napi_ok) return Undefined(env);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    napi_get_element(env, argv[0], i, &entry);
    napi_value fields[6];
    for (uint32_t f = 0; f < 6; f++) napi_get_element(env, entry, f, &fields[f]);
    OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, fields[0]));
    if (view == nil) continue;
    const bool visible = GetBool(env, fields[5]);
    if (visible) {
      view.frame = NSMakeRect(GetDouble(env, fields[1]), GetDouble(env, fields[2]), GetDouble(env, fields[3]),
                              GetDouble(env, fields[4]));
    }
    if (view.hidden == visible) {
      view.hidden = !visible;
      if (view.model->surface) ghostty_surface_set_occlusion(view.model->surface, visible);
      if (!visible && view.window.firstResponder == view) [view.window makeFirstResponder:nil];
    }
  }
  [CATransaction commit];
  return Undefined(env);
}

// focus(id): void
napi_value Focus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view != nil && !view.hidden && view.window.firstResponder != view) [view.window makeFirstResponder:view];
  return Undefined(env);
}

// setAppFocus(focused: boolean): void
napi_value SetAppFocus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (g_app) ghostty_app_set_focus(g_app, GetBool(env, argv[0]));
  return Undefined(env);
}

// performAction(id, action): boolean — a Ghostty binding action such as "copy_to_clipboard".
napi_value PerformAction(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.model->surface == nullptr) return Bool(env, false);
  const std::string action = GetString(env, argv[1]);
  return Bool(env, ghostty_surface_binding_action(view.model->surface, action.c_str(), action.size()));
}

// readSelection(id): string | null
napi_value ReadSelection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(view.model->surface, &text)) return result;
  result = String(env, std::string(text.text, text.text_len));
  ghostty_surface_free_text(view.model->surface, &text);
  return result;
}

// gridSize(id): { columns, rows, cellWidth, cellHeight } | null
napi_value GridSize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  ghostty_surface_size_s size = ghostty_surface_size(view.model->surface);
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "columns", Number(env, size.columns));
  napi_set_named_property(env, result, "rows", Number(env, size.rows));
  napi_set_named_property(env, result, "cellWidth", Number(env, size.cell_width_px));
  napi_set_named_property(env, result, "cellHeight", Number(env, size.cell_height_px));
  return result;
}

// processExit(id, exitCode): void
napi_value ProcessExit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view != nil && view.model->surface) {
    ghostty_surface_process_exit(view.model->surface, static_cast<uint32_t>(GetInt(env, argv[1])), 0);
  }
  return Undefined(env);
}

// destroySurface(id): void
napi_value DestroySurface(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int32_t id = GetInt(env, argv[0]);
  OrcaGhosttySurfaceView* view = ViewForId(id);
  if (view == nil) return Undefined(env);
  SurfaceModel* model = view.model;
  model->closed = true;
  if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
  [view removeFromSuperview];
  [g_views removeObjectForKey:@(id)];
  if (model->surface) ghostty_surface_free(model->surface);
  model->surface = nullptr;
  view.model = nullptr;
  napi_release_threadsafe_function(model->events, napi_tsfn_abort);
  delete model;
  return Undefined(env);
}

// debugKey(id, characters, keyCode, modifierFlags): void — synthetic keyDown+keyUp for headless tests.
napi_value DebugKey(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil) return Undefined(env);
  NSString* chars = [NSString stringWithUTF8String:GetString(env, argv[1]).c_str()];
  const auto keyCode = static_cast<unsigned short>(GetInt(env, argv[2]));
  const auto flags = static_cast<NSEventModifierFlags>(GetInt(env, argv[3]));
  for (NSEventType type : {NSEventTypeKeyDown, NSEventTypeKeyUp}) {
    NSEvent* event = [NSEvent keyEventWithType:type
                                      location:NSZeroPoint
                                 modifierFlags:flags
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:view.window.windowNumber
                                       context:nil
                                    characters:chars
                   charactersIgnoringModifiers:chars
                                     isARepeat:NO
                                       keyCode:keyCode];
    if (type == NSEventTypeKeyDown) [view keyDown:event];
    else [view keyUp:event];
  }
  return Undefined(env);
}

// debugScreenText(id): string | null — viewport text for headless output checks.
napi_value DebugScreenText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  // Whole viewport, read without touching the user's selection.
  ghostty_selection_s viewport = {};
  viewport.top_left = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_TOP_LEFT, 0, 0};
  viewport.bottom_right = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_BOTTOM_RIGHT, 0, 0};
  viewport.rectangle = false;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(view.model->surface, viewport, &text)) return result;
  result = String(env, std::string(text.text, text.text_len));
  ghostty_surface_free_text(view.model->surface, &text);
  return result;
}

// debugState(id): { hidden, firstResponder, x, y, width, height } | null
napi_value DebugState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil) return result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "hidden", Bool(env, view.hidden));
  napi_set_named_property(env, result, "firstResponder", Bool(env, view.window.firstResponder == view));
  napi_set_named_property(env, result, "x", Number(env, view.frame.origin.x));
  napi_set_named_property(env, result, "y", Number(env, view.frame.origin.y));
  napi_set_named_property(env, result, "width", Number(env, view.frame.size.width));
  napi_set_named_property(env, result, "height", Number(env, view.frame.size.height));
  id contents = view.layer.contents;
  if (contents != nil && CFGetTypeID((__bridge CFTypeRef)contents) == IOSurfaceGetTypeID()) {
    IOSurfaceRef surface = (__bridge IOSurfaceRef)contents;
    napi_set_named_property(env, result, "surfaceWidth", Number(env, IOSurfaceGetWidth(surface)));
    napi_set_named_property(env, result, "surfaceHeight", Number(env, IOSurfaceGetHeight(surface)));
  }
  napi_set_named_property(env, result, "layerClass",
                          String(env, view.layer ? object_getClassName(view.layer) : "none"));
  napi_set_named_property(env, result, "sublayers", Number(env, view.layer.sublayers.count));
  return result;
}

// debugSnapshot(id): Buffer | null — PNG of the frame Ghostty last presented (its IOSurface).
napi_value DebugSnapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  id contents = view.layer.contents;
  if (contents == nil || CFGetTypeID((__bridge CFTypeRef)contents) != IOSurfaceGetTypeID()) return result;
  CIImage* image = [CIImage imageWithIOSurface:(__bridge IOSurfaceRef)contents];
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCIImage:image];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (png == nil) return result;
  void* out = nullptr;
  napi_create_buffer_copy(env, png.length, png.bytes, &out, &result);
  return result;
}

napi_value ModuleInit(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"init", nullptr, Init, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"updateConfig", nullptr, UpdateConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createSurface", nullptr, CreateSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeOutput", nullptr, WriteOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setFrames", nullptr, SetFrames, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"focus", nullptr, Focus, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setAppFocus", nullptr, SetAppFocus, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSelection", nullptr, ReadSelection, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"performAction", nullptr, PerformAction, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"gridSize", nullptr, GridSize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"processExit", nullptr, ProcessExit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroySurface", nullptr, DestroySurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugKey", nullptr, DebugKey, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugSnapshot", nullptr, DebugSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugScreenText", nullptr, DebugScreenText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugState", nullptr, DebugState, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"gridSizeOf", nullptr, GridSize, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
