Remove-Item -Path .\addon.xpi
Get-ChildItem -Path .\ -Exclude pack.ps1,*.xpi,*.gitignore,*.gitattributes | Compress-Archive -CompressionLevel NoCompression -DestinationPath addon
Rename-Item -Path .\addon.zip -NewName addon.xpi