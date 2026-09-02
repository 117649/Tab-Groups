Remove-Item -LiteralPath "$PSScriptRoot\addon.xpi" -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $PSScriptRoot -Exclude .git,.github,.vscode,pack.ps1,debug.log,*.xpi,*.gitignore,*.gitattributes |
	Select-Object -ExpandProperty FullName |
	Compress-Archive -CompressionLevel NoCompression -DestinationPath "$PSScriptRoot\addon.zip"
Rename-Item -LiteralPath "$PSScriptRoot\addon.zip" -NewName addon.xpi
