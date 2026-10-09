; NSIS installer hooks (bundle > windows > nsis > installerHooks).

; Up to 0.5.0 the publisher was "Dorian Dubosc", and the installer saved its
; install dir under Software\<publisher>\<productName>. The publisher is now
; Captain-VII, so the new installer and uninstaller never touch the old key:
; delete it here, otherwise the author's name stays in every player's
; registry. The new key is already written by the Install section.
;
; Installs from before the product rename (productName "waystone-overlay")
; left a sibling subkey that kept the parent from being removed: verified on
; a real 0.5.0 -> 1.0.0-rc.1 update, the parent survived with only that
; subkey in it. Its install dir is long gone, so it is dropped as well.
!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey SHCTX "Software\Dorian Dubosc\Waystone-Analyzer"
  DeleteRegKey SHCTX "Software\Dorian Dubosc\waystone-overlay"
  DeleteRegKey /ifempty SHCTX "Software\Dorian Dubosc"
!macroend
