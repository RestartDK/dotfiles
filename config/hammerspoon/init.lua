local bridge = {}

local appBundleId = "com.mitchellh.ghostty"
local markerPrefix = "PI_GHOSTTY_IMAGE_V1:"
local maxImageBytes = 50 * 1024 * 1024

local function isGhosttyWindow(window)
	if not window then
		return false
	end
	local application = window:application()
	return application and application:bundleID() == appBundleId
end

local function imageMimeType(data)
	if data:sub(1, 8) == "\137PNG\r\n\026\n" then
		return "image/png"
	end
	if data:byte(1) == 0xff and data:byte(2) == 0xd8 and data:byte(3) == 0xff then
		return "image/jpeg"
	end
	if data:sub(1, 6) == "GIF87a" or data:sub(1, 6) == "GIF89a" then
		return "image/gif"
	end
	if data:sub(1, 4) == "RIFF" and data:sub(9, 12) == "WEBP" then
		return "image/webp"
	end
	return nil
end

local function markerForData(data, mimeType)
	if #data > maxImageBytes then
		hs.alert.show("Image is larger than 50 MB")
		return nil
	end
	return markerPrefix .. mimeType .. ":" .. hs.base64.encode(data)
end

local function markerForImage(image)
	if not image then
		return nil
	end
	local encoded = image:encodeAsURLString(false, "PNG")
	local dataUrlPrefix = "data:image/png;base64,"
	if not encoded or encoded:sub(1, #dataUrlPrefix) ~= dataUrlPrefix then
		hs.alert.show("Could not encode the clipboard image")
		return nil
	end
	local payload = encoded:sub(#dataUrlPrefix + 1)
	if #payload > math.ceil(maxImageBytes / 3) * 4 then
		hs.alert.show("Image is larger than 50 MB")
		return nil
	end
	return markerPrefix .. "image/png:" .. payload
end

local function decodeFileUrl(url)
	local path = url:gsub("^file://localhost", ""):gsub("^file://", "")
	return path:gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end)
end

local function markerForPath(path)
	local file = io.open(path, "rb")
	if file then
		local size = file:seek("end")
		if size and size > maxImageBytes then
			file:close()
			hs.alert.show("Image is larger than 50 MB")
			return nil
		end
		file:seek("set")
		local data = file:read("*a")
		file:close()
		local mimeType = imageMimeType(data)
		if mimeType then
			return markerForData(data, mimeType)
		end
	end
	return nil
end

local function pasteMarker(window, marker)
	if not isGhosttyWindow(window) or not marker then
		return false
	end
	local clipboard = hs.pasteboard.readAllData()
	if not hs.pasteboard.setContents(marker) then
		hs.alert.show("Could not stage the image for Pi")
		return false
	end
	window:focus()
	local application = window:application()
	local pasted = application and application:selectMenuItem({ "Edit", "Paste" })
	hs.timer.doAfter(0.5, function()
		if hs.pasteboard.getContents() == marker then
			hs.pasteboard.writeAllData(clipboard)
		end
	end)
	if not pasted then
		hs.alert.show("Could not paste the image into Ghostty")
	end
	return pasted == true
end

local function imageMarkerFromPasteboard(pasteboardName)
	local urls = hs.pasteboard.readURL(pasteboardName, true)
	if type(urls) == "string" then
		urls = { urls }
	end
	for _, url in ipairs(urls or {}) do
		if url:sub(1, 7) == "file://" then
			local marker = markerForPath(decodeFileUrl(url))
			if marker then
				return marker
			end
		end
	end
	return markerForImage(hs.pasteboard.readImage(pasteboardName))
end

local function pasteClipboardImage()
	local window = hs.window.focusedWindow()
	if not isGhosttyWindow(window) then
		return
	end
	local marker = imageMarkerFromPasteboard(nil)
	if marker then
		pasteMarker(window, marker)
		return
	end
	local application = window:application()
	if application then
		application:selectMenuItem({ "Edit", "Paste" })
	end
end

local pasteHotkey = hs.hotkey.new({ "cmd" }, "v", pasteClipboardImage)

local function refresh()
	if isGhosttyWindow(hs.window.focusedWindow()) then
		if not pasteHotkey.enabled then
			pasteHotkey:enable()
		end
	elseif pasteHotkey.enabled then
		pasteHotkey:disable()
	end
end

bridge.timer = hs.timer.doEvery(0.2, refresh)
bridge.pasteHotkey = pasteHotkey
bridge.refresh = refresh

hs.autoLaunch(true)
refresh()
_G.PiGhosttyImagePaste = bridge
