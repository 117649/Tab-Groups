Remove-Item -Path .\addon.xpi
Get-ChildItem -Path .\ -Exclude .git,.github,.vscode,pack.ps1,debug.log,*.xpi,*.gitignore,*.gitattributes | Compress-Archive -CompressionLevel NoCompression -DestinationPath addon
Rename-Item -Path .\addon.zip -NewName addon.xpi