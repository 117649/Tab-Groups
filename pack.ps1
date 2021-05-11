Remove-Item -Path .\addon.xpi
Get-ChildItem -Path .\ -Exclude pack.ps1,*.xpi | Compress-Archive -CompressionLevel NoCompression -DestinationPath addon
Rename-Item -Path .\addon.zip -NewName addon.xpi