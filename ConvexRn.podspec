require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
 s.name         = "ConvexRn"
 s.version      = package["version"]
 s.summary      = package["description"]
 s.homepage     = package["homepage"]
 s.license      = package["license"]
 s.authors      = package["author"]

 # SwiftData + App Intents require iOS 17+
 s.platforms    = { :ios => "17.0" }
 s.source       = { :git => "https://github.com/misterlib/convex-rn.git", :tag => "#{s.version}" }

 s.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
 # Notes AssistantSchemas require iOS 18+; core sync uses ConvexBridge + SwiftData only.
 s.exclude_files = "ios/siri/**/*"
 s.private_header_files = "ios/**/*.h"

 install_modules_dependencies(s)
end
